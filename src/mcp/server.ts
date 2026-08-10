import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getStatus, searchMemory, syncProject } from './tools.js';

/**
 * Local-only, stdio-transport MCP server exposing NexusMem's memory to any
 * MCP-capable client (Claude Desktop, Cursor, Windsurf, ...). No auth layer:
 * a client that can spawn this process already has the same filesystem
 * access the process itself would use.
 */
export function createServer(): McpServer {
  const server = new McpServer({ name: 'nexusmem', version: '0.1.0' });

  server.registerTool(
    'search_memory',
    {
      title: 'Search remembered project history',
      description:
        'Search a NexusMem-tracked repository\'s remembered history: git commits, shell commands, tracked markdown docs, and (if enabled) conversation transcripts. Returns a token-budgeted, ranked context block -- not raw search results.',
      inputSchema: {
        projectRoot: z.string().describe('Absolute path to the repository root'),
        query: z.string().describe('Free-text question or search terms'),
        budget: z.number().int().positive().optional().describe('Max tokens in the returned context block. Default 2000.'),
      },
    },
    async ({ projectRoot, query, budget }) => {
      const result = await searchMemory({ projectRoot, query, budget });
      // The packed context block goes in BOTH fields: clients differ on which
      // one they surface to the model, and a client that prefers
      // structuredContent would otherwise see only the match stats -- the
      // block itself (the tool's entire value) silently dropped.
      return {
        content: [{ type: 'text', text: result.text }],
        structuredContent: {
          text: result.text,
          matched: result.matched,
          bm25Matched: result.bm25Matched,
          vectorMatched: result.vectorMatched,
          tokensUsed: result.tokensUsed,
          tokensBudget: result.tokensBudget,
        } as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    'sync_project',
    {
      title: 'Sync remembered history',
      description:
        'Ingest new git, shell, docs and (if enabled) conversation history for a NexusMem-tracked repository into its local database.',
      inputSchema: {
        projectRoot: z.string().describe('Absolute path to the repository root'),
      },
    },
    async ({ projectRoot }) => {
      const result = await syncProject({ projectRoot });
      return { content: [{ type: 'text', text: result.summary }] };
    },
  );

  server.registerTool(
    'get_status',
    {
      title: 'Show what is remembered',
      description: 'Report how many nodes NexusMem currently remembers for a repository, broken down by kind and source.',
      inputSchema: {
        projectRoot: z.string().describe('Absolute path to the repository root'),
      },
    },
    async ({ projectRoot }) => {
      const result = await getStatus({ projectRoot });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );

  return server;
}

export async function runMcpServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
