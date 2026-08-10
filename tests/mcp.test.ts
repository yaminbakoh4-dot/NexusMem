import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from '../src/mcp/server.js';
import { getStatus, searchMemory, syncProject } from '../src/mcp/tools.js';
import { MemoryStore } from '../src/store/store.js';
import { makeProjectId } from '../src/core/project.js';
import { gitFixture } from './helpers.js';

/**
 * These exercise the MCP tool handlers directly (as plain async functions),
 * not through the MCP protocol/transport -- that layer is a thin,
 * SDK-owned wire format the SDK's own tests already cover. What's ours to
 * test is that these wrappers call the right underlying pipeline with the
 * right project scoping.
 */

function initGitRepo(dir: string): void {
  const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };
  const g = (...args: string[]) => gitFixture(dir, args, { env });
  g('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'hello\n');
  g('add', '.');
  g('commit', '-q', '-m', 'fix: handle the retry timeout correctly\n\nThe old code retried forever instead of giving up after N attempts.');
}

describe('mcp tools', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'nexusmem-mcp-'));
    initGitRepo(repoDir);
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('sync_project ingests git history and reports it in the summary', async () => {
    const result = await syncProject({ projectRoot: repoDir, noEmbed: true });
    expect(result.summary).toContain('synced');
    expect(result.summary).toContain('1 commit');
  });

  it('get_status reflects what sync_project just ingested', async () => {
    await syncProject({ projectRoot: repoDir, noEmbed: true });
    const status = await getStatus({ projectRoot: repoDir });
    expect(status.total).toBeGreaterThanOrEqual(1);
    expect(status.byKind.git_commit).toBe(1);
    expect(status.sources.some((s) => s.source === 'git')).toBe(true);
  });

  it('search_memory finds a synced commit by keyword, BM25-only when no embedding provider is reachable', async () => {
    await syncProject({ projectRoot: repoDir, noEmbed: true });
    const result = await searchMemory({ projectRoot: repoDir, query: 'retry timeout', noVector: true });
    expect(result.text).toContain('retry timeout');
    expect(result.bm25Matched).toBeGreaterThan(0);
  });

  it('search_memory on an uninitialized project returns no matches instead of throwing', async () => {
    const result = await searchMemory({ projectRoot: repoDir, query: 'anything', noVector: true });
    expect(result.matched).toBe(0);
  });

  it('scopes tool calls to the correct project via projectRoot, not any implicit cwd', async () => {
    const otherDir = mkdtempSync(join(tmpdir(), 'nexusmem-mcp-other-'));
    initGitRepo(otherDir);
    writeFileSync(join(otherDir, 'b.txt'), 'x\n');
    gitFixture(otherDir, ['add', '.']);
    gitFixture(otherDir, ['commit', '-q', '-m', 'feat: unrelated other-project change'], {
      env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' },
    });

    try {
      await syncProject({ projectRoot: repoDir, noEmbed: true });
      await syncProject({ projectRoot: otherDir, noEmbed: true });

      const statusA = await getStatus({ projectRoot: repoDir });
      const statusB = await getStatus({ projectRoot: otherDir });

      const idA = makeProjectId({ root: repoDir, originUrl: null });
      const idB = makeProjectId({ root: otherDir, originUrl: null });
      expect(idA).not.toBe(idB);
      expect(statusA.byKind.git_commit).toBe(1);
      expect(statusB.byKind.git_commit).toBe(2); // initGitRepo's commit + the extra one above
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  /**
   * `stdout` is not a free-for-all log here -- it is the MCP transport itself.
   *
   * `StdioServerTransport` stores the *stream object*
   * (`server/stdio.js:11  this._stdout = _stdout`, defaulting to
   * `process.stdout`) and resolves `.write` at call time
   * (`server/stdio.js:72  this._stdout.write(json)`). So anything that
   * reassigns `process.stdout.write` also reassigns the transport's outbound
   * path: a JSON-RPC response sent while a sync is in flight is swallowed by
   * the capture buffer, and the SDK sees the patched `return true` as proof it
   * was delivered. Two overlapping syncs additionally leave the restore
   * chain broken, because the second one saves the first one's patch as
   * "the original".
   *
   * Capturing the summary is a legitimate need; taking it from a shared global
   * is not. The invariant is that the tool layer routes output explicitly.
   */
  it('never reassigns process.stdout.write, because stdout is the MCP transport', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'write');
    let current = process.stdout.write;
    let assignments = 0;

    Object.defineProperty(process.stdout, 'write', {
      configurable: true,
      get: () => current,
      // Record, then apply, so today's behavior is unchanged and the test
      // observes rather than breaks it.
      set: (fn) => {
        assignments += 1;
        current = fn;
      },
    });

    let summary: string;
    try {
      summary = (await syncProject({ projectRoot: repoDir, noEmbed: true })).summary;
    } finally {
      if (descriptor) Object.defineProperty(process.stdout, 'write', descriptor);
      else Reflect.deleteProperty(process.stdout, 'write');
    }

    expect(assignments).toBe(0);
    // The capture must keep working -- the point is to change where it reads
    // from, not to give up reporting the sync summary.
    expect(summary).toContain('synced');
  });
});

describe('mcp server result shaping (protocol round trip)', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'nexusmem-mcp-proto-'));
    initGitRepo(repoDir);
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  /**
   * Regression test for a live failure (2026-08-09): search_memory's packed
   * context block lived only in content[0].text, while structuredContent
   * carried just the match stats. An MCP client that surfaces
   * structuredContent in preference to content (Claude Code does) showed the
   * model `{matched: 38, ...}` and silently dropped the block -- the tool's
   * entire value. The block must therefore be present in BOTH fields.
   */
  it('search_memory exposes the context block in content AND structuredContent', async () => {
    await syncProject({ projectRoot: repoDir, noEmbed: true });

    const server = createServer();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const result = (await client.callTool({
        name: 'search_memory',
        arguments: { projectRoot: repoDir, query: 'retry timeout' },
      })) as {
        content: Array<{ type: string; text: string }>;
        structuredContent?: Record<string, unknown>;
        isError?: boolean;
      };

      expect(result.isError).toBeFalsy();

      const contentText = result.content[0]?.text ?? '';
      expect(contentText).toContain('retry timeout');

      expect(result.structuredContent).toBeDefined();
      expect(result.structuredContent?.text).toBe(contentText);
      expect(result.structuredContent?.matched).toBeGreaterThan(0);
    } finally {
      await client.close();
      await server.close();
    }
  });

  /**
   * Tool descriptions enumerate the sources NexusMem indexes, and that list is
   * the only thing a model reads when deciding whether this tool can answer a
   * question. It had already gone stale: the docs collector shipped in
   * `ce658c6` and is on by default, but both descriptions still advertised
   * only git, shell and conversation -- so a question about project prose
   * looked out of scope for a tool that could in fact answer it.
   *
   * Prose drifts silently in a way code does not, hence this guard.
   */
  it('advertises every source the sync pipeline actually ingests', async () => {
    const server = createServer();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const { tools } = await client.listTools();
      const describing = (name: string) => tools.find((t) => t.name === name)?.description ?? '';

      for (const name of ['search_memory', 'sync_project']) {
        const description = describing(name).toLowerCase();
        expect(description, `${name} has no description`).not.toBe('');
        for (const source of ['git', 'shell', 'docs', 'conversation']) {
          expect(description, `${name} does not mention the ${source} source`).toContain(source);
        }
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('vector coverage sanity via store (used by search_memory)', () => {
  it('EMBEDDING_DIM-shaped nodes_vec table exists on a freshly opened store', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexusmem-mcp-store-'));
    const store = MemoryStore.open(join(dir, 'memory.db'));
    const row = store.raw.prepare("SELECT name FROM sqlite_master WHERE name = 'nodes_vec'").get();
    expect(row).toBeDefined();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
