import { Command } from 'commander';
import pc from 'picocolors';
import { ConfigError } from '../config/workspace.js';
import { readOwnVersion } from '../core/version.js';
import { GitCrashError, GitSpawnError } from '../git/exec.js';
import { NotAGitRepositoryError } from '../git/repo.js';
import { ProfileNotFoundError } from '../hooks/install.js';
import { runHookInstall, runHookRemove, runHookStatus } from './commands/hook.js';
import { runInit } from './commands/init.js';
import { runProjects } from './commands/projects.js';
import { runMcpServer } from '../mcp/server.js';
import { runQuery } from './commands/query.js';
import { runScanConversation } from './commands/scan-conversation.js';
import { runScanDiff } from './commands/scan-diff.js';
import { runScanDocs } from './commands/scan-docs.js';
import { runScanGit } from './commands/scan-git.js';
import { runScanShell } from './commands/scan-shell.js';
import { runStatus } from './commands/status.js';
import { runSync } from './commands/sync.js';

/** Failures the user can act on, reported without a stack trace. */
function isExpected(err: unknown): err is Error {
  return (
    err instanceof NotAGitRepositoryError ||
    // "git isn't installed" and "the spawn failed, try again" are both things
    // the user fixes, not stack traces they debug.
    err instanceof GitSpawnError ||
    // Survived every retry, so git is genuinely unstable on this machine
    // (antivirus, a bad install). Actionable, and not our stack to print.
    err instanceof GitCrashError ||
    err instanceof ConfigError ||
    err instanceof ProfileNotFoundError
  );
}

/** Wrap a command so expected failures exit 1 with a clean message. */
function guard(run: () => Promise<number>): () => Promise<void> {
  return async () => {
    try {
      process.exitCode = await run();
    } catch (err) {
      if (isExpected(err)) {
        process.stderr.write(`${pc.red('error')} ${err.message}\n`);
        process.exitCode = 1;
        return;
      }
      throw err;
    }
  };
}

const program = new Command();

program
  .name('nexusmem')
  .description('NexusMem — local-first persistent memory for AI coding agents')
  .version(readOwnVersion());

program
  .command('init')
  .description('Create the .nexusmem workspace and database for this repository')
  .option('-C, --cwd <path>', 'repository path', process.cwd())
  .option('--force', 'overwrite an existing config (the database is kept)', false)
  .option('--hook', 'also install the opt-in PowerShell hook (cwd + exit code + timestamp)', false)
  .option('--enable-conversation', 'opt in to the conversation-transcript source (off by default -- see docs/phase-2-spec.md)', false)
  .action((options) =>
    guard(() =>
      runInit({ cwd: options.cwd, force: options.force, hook: options.hook, enableConversation: options.enableConversation }),
    )(),
  );

program
  .command('sync')
  .description('Ingest new history into the local database')
  .option('-C, --cwd <path>', 'repository path', process.cwd())
  .option('--full', 'ignore the stored cursor and re-walk all history', false)
  .option('--rebuild', 'drop this project\'s nodes and re-ingest from scratch', false)
  .option('--since <date>', 'override the configured git cutoff, e.g. 1.year.ago')
  .option('--shell-lines <count>', 'override the configured shell tail-window size', (v) => Number.parseInt(v, 10))
  .option('--conversation', 'force the conversation source on for this run, without persisting it to config', false)
  .option('--no-embed', 'skip the vector-embedding pass for this run')
  .option('--embed-limit <count>', 'stop embedding after this many nodes (default: embed everything pending)', (v) =>
    Number.parseInt(v, 10),
  )
  .option('-q, --quiet', 'only print the final summary', false)
  .action((options) =>
    guard(() =>
      runSync({
        cwd: options.cwd,
        full: options.full,
        rebuild: options.rebuild,
        since: options.since,
        shellTailLines: options.shellLines,
        conversationOverride: options.conversation ? true : undefined,
        noEmbed: !options.embed,
        embedLimit: options.embedLimit,
        quiet: options.quiet,
      }),
    )(),
  );

program
  .command('hook')
  .description('Manage the opt-in PowerShell hook that logs cwd + exit code + timestamp')
  .addCommand(
    new Command('install')
      .description('Install (or update) the hook in your PowerShell profile')
      .option('--profile <path>', 'override the auto-detected $PROFILE path')
      .action((options) => guard(() => runHookInstall({ profile: options.profile }))()),
  )
  .addCommand(
    new Command('remove')
      .description('Remove the hook block from your PowerShell profile')
      .option('--profile <path>', 'override the auto-detected $PROFILE path')
      .action((options) => guard(() => runHookRemove({ profile: options.profile }))()),
  )
  .addCommand(
    new Command('status')
      .description('Show whether the hook is installed')
      .option('--profile <path>', 'override the auto-detected $PROFILE path')
      .action((options) => guard(() => runHookStatus({ profile: options.profile }))()),
  );

program
  .command('status')
  .description('Show what is currently remembered for this repository')
  .option('-C, --cwd <path>', 'repository path', process.cwd())
  .action((options) => guard(() => runStatus({ cwd: options.cwd }))());

program
  .command('query')
  .description('Search remembered history and print a token-budgeted context block')
  .argument('<text>', 'free-text query')
  .option('-C, --cwd <path>', 'repository path', process.cwd())
  .option('-b, --budget <tokens>', 'max tokens in the packed context', (v) => Number.parseInt(v, 10), 2000)
  .option('-n, --candidates <count>', 'how many search hits to rank before packing', (v) => Number.parseInt(v, 10), 30)
  .option('--half-life <days>', 'days for a node\'s recency weight to halve', (v) => Number.parseFloat(v))
  .option('--no-vector', 'BM25 only -- skip embedding the query and vector search')
  .option('-a, --all-projects', 'search every registered repository, not just this one', false)
  .option('--json', 'emit the packed result as JSON on stdout', false)
  .action((text: string, options) =>
    guard(() =>
      runQuery({
        cwd: options.cwd,
        query: text,
        budget: options.budget,
        candidates: options.candidates,
        halfLifeDays: options.halfLife,
        noVector: !options.vector,
        allProjects: options.allProjects,
        json: options.json,
      }),
    )(),
  );

program
  .command('projects')
  .description('List the repositories `query --all-projects` would search')
  .option('--prune', 'forget registered projects whose database is no longer on disk', false)
  .option('--json', 'emit the registry as JSON on stdout', false)
  .action((options) => guard(() => runProjects({ prune: options.prune, json: options.json }))());

program
  .command('scan-git')
  .description('Preview the MemoryNodes git history would produce (writes nothing)')
  .option('-C, --cwd <path>', 'repository path', process.cwd())
  .option('--since <date>', 'only commits newer than this git date expression, e.g. 90.days.ago')
  .option('-n, --limit <count>', 'stop after N commits', (v) => Number.parseInt(v, 10))
  .option('--no-merges', 'skip merge commits')
  .option('--min-signal <score>', 'drop nodes below this signal', (v) => Number.parseFloat(v), 0)
  .option('--json', 'emit MemoryNodes as JSON on stdout', false)
  .action((options) =>
    guard(() =>
      runScanGit({
        cwd: options.cwd,
        since: options.since,
        limit: options.limit,
        merges: options.merges,
        json: options.json,
        minSignal: options.minSignal,
      }),
    )(),
  );

program
  .command('scan-diff')
  .description('Preview the MemoryNodes commit patches would produce, one per changed file (writes nothing)')
  .option('-C, --cwd <path>', 'repository path', process.cwd())
  .option('--since <date>', 'only commits newer than this git date expression, e.g. 90.days.ago')
  .option('-n, --limit <count>', 'stop after N commits (not N nodes)', (v) => Number.parseInt(v, 10))
  .option('--min-signal <score>', 'drop nodes below this signal', (v) => Number.parseFloat(v), 0)
  .option('--json', 'emit MemoryNodes as JSON on stdout', false)
  .action((options) =>
    guard(() =>
      runScanDiff({
        cwd: options.cwd,
        since: options.since,
        limit: options.limit,
        json: options.json,
        minSignal: options.minSignal,
      }),
    )(),
  );

program
  .command('scan-shell')
  .description('Preview the MemoryNodes shell history would produce (writes nothing)')
  .option('-C, --cwd <path>', 'repository path', process.cwd())
  .option('-n, --tail-lines <count>', 'lines kept from each scrape-based source', (v) => Number.parseInt(v, 10), 300)
  .option('--min-signal <score>', 'drop nodes below this signal', (v) => Number.parseFloat(v), 0)
  .option('--json', 'emit MemoryNodes as JSON on stdout', false)
  .action((options) =>
    guard(() =>
      runScanShell({ cwd: options.cwd, tailLines: options.tailLines, minSignal: options.minSignal, json: options.json }),
    )(),
  );

program
  .command('scan-conversation')
  .description('Preview the MemoryNodes the conversation transcript would produce (writes nothing)')
  .option('-C, --cwd <path>', 'repository path', process.cwd())
  .option('--min-signal <score>', 'drop nodes below this signal', (v) => Number.parseFloat(v), 0)
  .option('--json', 'emit MemoryNodes as JSON on stdout', false)
  .action((options) =>
    guard(() => runScanConversation({ cwd: options.cwd, minSignal: options.minSignal, json: options.json }))(),
  );

program
  .command('scan-docs')
  .description('Preview the MemoryNodes tracked .md files would produce (writes nothing)')
  .option('-C, --cwd <path>', 'repository path', process.cwd())
  .option('--min-signal <score>', 'drop nodes below this signal', (v) => Number.parseFloat(v), 0)
  .option('--json', 'emit MemoryNodes as JSON on stdout', false)
  .action((options) => guard(() => runScanDocs({ cwd: options.cwd, minSignal: options.minSignal, json: options.json }))());

program
  .command('mcp')
  .description('Start the MCP server (stdio transport) for Claude Desktop, Cursor, Windsurf, etc.')
  .action(() => guard(() => runMcpServer().then(() => 0))());

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${pc.red('error')} ${message}\n`);
  process.exitCode = 1;
});
