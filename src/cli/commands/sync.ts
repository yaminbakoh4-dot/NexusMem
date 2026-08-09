import pc from 'picocolors';
import { collectConversationTurns } from '../../collectors/conversation.js';
import { collectDocFiles } from '../../collectors/docs.js';
import { collectGitCommits } from '../../collectors/git-commits.js';
import { collectShellHistory } from '../../collectors/shell-history.js';
import { collectClaudeCodeTranscripts } from '../../conversation/claude-code-reader.js';
import type { MemoryNode } from '../../core/types.js';
import { readDocFiles } from '../../docs/read.js';
import { isAncestor } from '../../git/repo.js';
import { collectAvailableShellHistory } from '../../shell/detect.js';
import { MemoryStore, type IngestStats } from '../../store/store.js';
import { OllamaEmbeddingProvider } from '../../vector/embed.js';
import { embedPendingNodes } from '../../vector/sync.js';
import { loadContext } from '../context.js';

export interface SyncOptions {
  cwd: string;
  /** Ignore the stored cursor and re-walk all history (still deduplicated). */
  full: boolean;
  /** Delete this project's nodes first, then re-ingest from scratch. */
  rebuild: boolean;
  /** Overrides `sources.git.since` from config for this run. */
  since?: string;
  /** Overrides `sources.shell.tailLines` from config for this run. */
  shellTailLines?: number;
  /** Forces the (opt-in) conversation source on for this run without persisting it to config. */
  conversationOverride?: boolean;
  /** Skip the embedding pass entirely -- useful when Ollama isn't running and you don't want to wait out its timeout. */
  noEmbed?: boolean;
  quiet: boolean;
}

/**
 * Rows per transaction.
 *
 * Large enough that per-transaction overhead disappears, small enough that a
 * huge repository does not hold every node in memory before the first write.
 */
const BATCH_SIZE = 500;

const GIT_SOURCE = 'git';

function addStats(into: IngestStats, from: IngestStats): void {
  into.inserted += from.inserted;
  into.updated += from.updated;
  into.unchanged += from.unchanged;
}

async function syncGit(
  store: MemoryStore,
  projectId: string,
  opts: SyncOptions,
  repo: Awaited<ReturnType<typeof loadContext>>['repo'],
  config: Awaited<ReturnType<typeof loadContext>>['config'],
  log: (line: string) => void,
): Promise<{ totals: IngestStats; seen: number }> {
  const totals: IngestStats = { inserted: 0, updated: 0, unchanged: 0 };

  if (!repo.head) {
    log(`${pc.yellow('git')} skipped -- repository has no commits yet`);
    return { totals, seen: 0 };
  }
  if (!config.sources.git.enabled) {
    log(`${pc.dim('git')} disabled in config`);
    return { totals, seen: 0 };
  }

  let cursor = opts.full || opts.rebuild ? null : store.getSyncCursor(projectId, GIT_SOURCE);

  if (cursor && !(await isAncestor(repo.root, cursor, repo.head))) {
    log(`${pc.yellow('git cursor stale')} ${cursor.slice(0, 7)} is not an ancestor of HEAD — falling back to a full walk`);
    cursor = null;
  }

  if (cursor === repo.head) {
    log(`${pc.green('git up to date')} at ${repo.head.slice(0, 7)}`);
    store.setSyncCursor(projectId, GIT_SOURCE, repo.head);
    return { totals, seen: 0 };
  }

  log(
    `${pc.dim('git syncing')} ${repo.branch ?? 'HEAD'} ${cursor ? `${cursor.slice(0, 7)}..${repo.head.slice(0, 7)}` : '(full history)'}`,
  );

  let batch: MemoryNode[] = [];
  let seen = 0;

  const flush = () => {
    if (batch.length === 0) return;
    addStats(totals, store.upsertNodes(batch));
    batch = [];
    log(`  ${pc.dim(`${seen} commits read, ${totals.inserted} new`)}`);
  };

  const nodes = collectGitCommits(repo.root, projectId, {
    afterCommit: cursor,
    since: opts.since ?? config.sources.git.since,
    includeMerges: config.sources.git.includeMerges,
    maxFilesPerNode: config.limits.maxFilesPerNode,
    maxBodyChars: config.limits.maxBodyChars,
  });

  for await (const node of nodes) {
    batch.push(node);
    seen += 1;
    if (batch.length >= BATCH_SIZE) flush();
  }
  flush();

  // Only advance the cursor once the walk completed without throwing -- a
  // crash mid-sync leaves the old cursor, and the next run redoes the range
  // (harmlessly, because ingestion is idempotent).
  store.setSyncCursor(projectId, GIT_SOURCE, repo.head);
  return { totals, seen };
}

async function syncShell(
  store: MemoryStore,
  projectId: string,
  opts: SyncOptions,
  repoRoot: string,
  config: Awaited<ReturnType<typeof loadContext>>['config'],
  log: (line: string) => void,
): Promise<{ totals: IngestStats; seen: number }> {
  const totals: IngestStats = { inserted: 0, updated: 0, unchanged: 0 };

  if (!config.sources.shell.enabled) {
    log(`${pc.dim('shell')} disabled in config`);
    return { totals, seen: 0 };
  }

  const results = await collectAvailableShellHistory({
    tailLines: opts.shellTailLines ?? config.sources.shell.tailLines,
    repoRoot,
    hookCursor: store.getSyncCursor(projectId, 'shell:pwsh-hook'),
  });

  if (results.length === 0) {
    log(`${pc.dim('shell')} no history source found on this machine`);
    return { totals, seen: 0 };
  }

  let seen = 0;
  for (const result of results) {
    const sourceKey = `shell:${result.name}`;
    const nodes = collectShellHistory(result.entries, projectId, { maxBodyChars: config.limits.maxBodyChars });
    seen += nodes.length;

    if (nodes.length > 0) {
      addStats(totals, store.upsertNodes(nodes));
    }

    // Hook source is a real append-only log: advance a walk-forward cursor.
    // Scrape sources re-read their tail window every run (bounded, cheap,
    // and self-deduplicating via content-addressed ids) so their "cursor" is
    // informational only, for `status` to show a last-synced marker.
    store.setSyncCursor(projectId, sourceKey, result.cursorAfter ?? `scanned:${result.entries.length}`);
    log(`  ${pc.dim(`${sourceKey}: ${nodes.length} entr${nodes.length === 1 ? 'y' : 'ies'} read`)}`);
  }

  return { totals, seen };
}

const CONVERSATION_SOURCE = 'conversation:claude-code';

async function syncConversation(
  store: MemoryStore,
  projectId: string,
  repoRoot: string,
  config: Awaited<ReturnType<typeof loadContext>>['config'],
  log: (line: string) => void,
  forceEnabled: boolean | undefined,
): Promise<{ totals: IngestStats; seen: number }> {
  const totals: IngestStats = { inserted: 0, updated: 0, unchanged: 0 };
  const enabled = forceEnabled ?? config.sources.conversation.enabled;

  if (!enabled) {
    // Opt-in and silent by default -- this source is off for almost every
    // sync, and it would be noise to announce that on every single run.
    return { totals, seen: 0 };
  }

  const turns = await collectClaudeCodeTranscripts(repoRoot);
  if (turns.length === 0) {
    log(`${pc.dim('conversation')} no transcripts found`);
    return { totals, seen: 0 };
  }

  const nodes = collectConversationTurns(turns, projectId, { maxBodyChars: config.limits.maxBodyChars });
  if (nodes.length > 0) addStats(totals, store.upsertNodes(nodes));

  // Re-read in full each sync (see claude-code-reader.ts) -- the cursor here
  // is informational only, matching the shell scrape sources.
  store.setSyncCursor(projectId, CONVERSATION_SOURCE, `scanned:${nodes.length}`);
  log(`  ${pc.dim(`${CONVERSATION_SOURCE}: ${nodes.length} of ${turns.length} exchange(s) kept`)}`);

  return { totals, seen: nodes.length };
}

const DOCS_SOURCE = 'docs';

async function syncDocs(
  store: MemoryStore,
  projectId: string,
  repoRoot: string,
  config: Awaited<ReturnType<typeof loadContext>>['config'],
  log: (line: string) => void,
): Promise<{ totals: IngestStats; seen: number }> {
  const totals: IngestStats = { inserted: 0, updated: 0, unchanged: 0 };

  if (!config.sources.docs.enabled) {
    log(`${pc.dim('docs')} disabled in config`);
    return { totals, seen: 0 };
  }

  const { files, unreadable } = await readDocFiles(repoRoot, { include: config.sources.docs.include });

  const nodes = collectDocFiles(files, projectId, { maxBodyChars: config.limits.maxBodyChars });
  if (nodes.length > 0) addStats(totals, store.upsertNodes(nodes));

  // Prune *after* the upsert, so a renamed heading's replacement is already in
  // place and only the stranded original is left to remove.
  //
  // This scan is always a complete one -- every tracked .md file, re-read in
  // full -- which is what makes the delete safe: anything of this source not in
  // `nodes` genuinely no longer exists in the repository. An empty scan is a
  // legitimate outcome (every .md file deleted) and prunes accordingly; files
  // that could not be read are excluded rather than treated as gone.
  const pruned = store.pruneSourceNodes(
    projectId,
    DOCS_SOURCE,
    nodes.map((node) => node.id),
    { keepPaths: unreadable },
  );

  // Re-read in full each sync, the same trade the conversation source makes:
  // content-addressed ids make it idempotent, and a doc file has no cheap
  // append-only cursor to walk incrementally.
  store.setSyncCursor(projectId, DOCS_SOURCE, `scanned:${nodes.length}`);

  if (files.length === 0 && unreadable.length === 0) {
    log(`${pc.dim('docs')} no tracked .md files found`);
  } else {
    const prunedPart = pruned > 0 ? `, ${pc.yellow(`${pruned} stale removed`)}` : '';
    const skippedPart = unreadable.length > 0 ? `, ${unreadable.length} unreadable (kept)` : '';
    log(`  ${pc.dim(`${DOCS_SOURCE}: ${nodes.length} section(s) from ${files.length} file(s)`)}${prunedPart}${pc.dim(skippedPart)}`);
  }

  return { totals, seen: nodes.length };
}

export async function runSync(opts: SyncOptions): Promise<number> {
  const { repo, ws, projectId, config } = await loadContext(opts.cwd);
  const log = (line: string) => {
    if (!opts.quiet) process.stderr.write(`${line}\n`);
  };

  const store = MemoryStore.open(ws.dbPath);
  const started = Date.now();

  try {
    store.upsertProject({ id: projectId, root: repo.root, originUrl: repo.originUrl });

    if (opts.rebuild) {
      const removed = store.clearProject(projectId);
      log(`${pc.dim('rebuild')} dropped ${removed} existing node(s)`);
    }

    const git = await syncGit(store, projectId, opts, repo, config, log);
    const shell = await syncShell(store, projectId, opts, repo.root, config, log);
    const conversation = await syncConversation(store, projectId, repo.root, config, log, opts.conversationOverride);
    const docs = await syncDocs(store, projectId, repo.root, config, log);

    let embedLine = '';
    if (!opts.noEmbed) {
      const result = await embedPendingNodes(store, new OllamaEmbeddingProvider(), projectId);
      if (result.embedded > 0) {
        embedLine = `  ${pc.dim(`vector: ${result.embedded} node(s) embedded`)}${result.skipped > 0 ? pc.dim(`, ${result.skipped} skipped`) : ''}\n`;
      } else if (result.providerUnavailable) {
        log(`${pc.dim('vector')} embedding provider unavailable (is Ollama running with nomic-embed-text pulled?) -- BM25-only for now`);
      }
    }

    store.markSynced(projectId);

    const totals: IngestStats = { inserted: 0, updated: 0, unchanged: 0 };
    addStats(totals, git.totals);
    addStats(totals, shell.totals);
    addStats(totals, conversation.totals);
    addStats(totals, docs.totals);

    const stats = store.stats(projectId);
    const elapsed = ((Date.now() - started) / 1000).toFixed(2);

    const conversationEnabled = opts.conversationOverride ?? config.sources.conversation.enabled;
    const conversationPart = conversationEnabled ? `, ${conversation.seen} conversation exchange(s)` : '';
    const docsPart = config.sources.docs.enabled ? `, ${docs.seen} doc section(s)` : '';

    process.stdout.write(
      [
        `${pc.green('synced')} ${git.seen} commit(s), ${shell.seen} shell entr${shell.seen === 1 ? 'y' : 'ies'}${conversationPart}${docsPart} in ${elapsed}s`,
        `  ${pc.green(`+${totals.inserted} new`)}  ${pc.yellow(`~${totals.updated} updated`)}  ${pc.dim(`=${totals.unchanged} unchanged`)}`,
        `  ${pc.dim(`${stats.total} node(s) total across ${stats.distinctFiles} file path(s)`)}`,
        '',
      ].join('\n') + embedLine,
    );

    return 0;
  } finally {
    store.close();
  }
}
