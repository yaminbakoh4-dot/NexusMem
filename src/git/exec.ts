import { spawn } from 'node:child_process';

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

/**
 * `git` could not be started at all -- distinct from git starting and then
 * exiting non-zero (`GitError`).
 *
 * Worth its own type because the two have nothing in common diagnostically:
 * a `GitError` is git's own verdict about the repository, while this means we
 * never got git's opinion. Collapsing them is what previously let a failed
 * process spawn be reported as "not a git repository", pointing the user at
 * their repo when the repo was fine.
 */
export class GitSpawnError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    /** libuv errno string (`ENOENT`, `EPERM`, ...), or `undefined` if the platform gave none. */
    readonly code: string | undefined,
    /** Whether retrying the identical command could plausibly succeed. */
    readonly transient: boolean,
    override readonly cause: unknown,
  ) {
    super(message);
    this.name = 'GitSpawnError';
  }
}

/**
 * Spawn failures that are worth retrying rather than reporting as a broken
 * setup.
 *
 * Windows is the reason this list exists: under process-creation pressure
 * (antivirus scanning a new image, handle exhaustion) `uv_spawn` intermittently
 * returns `EPERM` or `EAGAIN` for a binary that is present and runnable, and
 * succeeds on an immediate retry. `ENOENT` is deliberately absent -- git being
 * missing, or the cwd not existing, does not fix itself.
 */
const TRANSIENT_SPAWN_CODES = new Set(['EAGAIN', 'EPERM', 'EACCES', 'EMFILE', 'ENFILE', 'ENOMEM', 'EBUSY', 'ETXTBSY']);

function toSpawnError(err: unknown, cwd: string, args: string[]): GitSpawnError {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;

  if (code === 'ENOENT') {
    // Ambiguous by design in libuv: the missing thing is either the binary or
    // the cwd, and the error carries nothing that tells them apart.
    return new GitSpawnError(
      `Could not run git: either git is not on PATH, or the directory does not exist: ${cwd}`,
      args,
      code,
      false,
      err,
    );
  }

  const transient = code !== undefined && TRANSIENT_SPAWN_CODES.has(code);
  const suffix = transient ? ' This is usually transient on Windows -- retrying the same command often succeeds.' : '';

  return new GitSpawnError(
    `Could not start git (${code ?? 'unknown spawn failure'}) in ${cwd}.${suffix}`,
    args,
    code,
    transient,
    err,
  );
}

/**
 * Flags applied to every invocation.
 *
 * - `core.quotePath=false` keeps non-ASCII paths readable instead of `\303\251`.
 * - `--no-pager` / `core.pager=` stops git from ever trying to spawn `less`.
 */
const BASE_ARGS = ['-c', 'core.quotePath=false', '-c', 'core.pager=', '--no-pager'];

/**
 * Backoff between spawn retries, in milliseconds. Length sets the retry count.
 *
 * The failures this covers are short-lived contention (an antivirus scanner
 * holding a new image, momentary handle exhaustion), so the useful waits are
 * tens to low hundreds of milliseconds. A worst-case run adds ~600ms before
 * giving up, and only on a path that was going to fail outright before.
 */
const RETRY_DELAYS_MS = [50, 150, 400];

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface GitExecOptions {
  /** Injectable for deterministic tests; defaults to `child_process.spawn`. */
  spawn?: typeof spawn;
  /** Injectable for deterministic tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Stream `git <args>` stdout as UTF-8 chunks, retrying a transient failure to
 * start the process.
 *
 * Retrying is safe here only because a spawn failure happens strictly before
 * any output exists: once `git` is running, every remaining failure mode is an
 * exit code (`GitError`), which is git's own answer and must not be retried.
 * The `produced` guard enforces that boundary rather than assuming it -- once a
 * single chunk has reached the consumer, re-running the command would duplicate
 * output into a parser mid-parse, so at that point the error propagates.
 */
export async function* gitStream(cwd: string, args: string[], opts: GitExecOptions = {}): AsyncGenerator<string> {
  const sleep = opts.sleep ?? realSleep;

  for (let attempt = 0; ; attempt += 1) {
    let produced = false;
    try {
      for await (const chunk of runGitOnce(cwd, args, opts)) {
        produced = true;
        yield chunk;
      }
      return;
    } catch (err) {
      const retryable = err instanceof GitSpawnError && err.transient;
      if (produced || !retryable || attempt >= RETRY_DELAYS_MS.length) throw err;
      await sleep(RETRY_DELAYS_MS[attempt]!);
    }
  }
}

async function* runGitOnce(cwd: string, args: string[], opts: GitExecOptions): AsyncGenerator<string> {
  const fullArgs = [...BASE_ARGS, ...args];
  const child = (opts.spawn ?? spawn)('git', fullArgs, { cwd, windowsHide: true });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  let stderr = '';
  child.stderr.on('data', (chunk: string) => {
    // Bounded, so a pathological repo cannot blow up memory via stderr.
    if (stderr.length < 64 * 1024) stderr += chunk;
  });

  const exited = new Promise<number>((resolve, reject) => {
    child.once('error', (err) => reject(toSpawnError(err, cwd, fullArgs)));
    child.once('close', (code) => resolve(code ?? 0));
  });
  // A spawn failure rejects `exited` before the stdout loop below has a
  // consumer for it; without this the rejection is unhandled for a tick even
  // though we do await it further down.
  exited.catch(() => {});

  try {
    for await (const chunk of child.stdout) {
      yield chunk as string;
    }
  } finally {
    // Consumer broke out early (e.g. hit --limit): don't leave git running.
    if (child.exitCode === null) child.kill();
  }

  const code = await exited;
  if (code !== 0) {
    const trimmed = stderr.trim();
    // Lead with git's own first line: now that callers no longer rewrite every
    // failure into "not a git repository", this message is what the user sees
    // for the cases that aren't specifically handled.
    const detail = trimmed.split('\n')[0];
    throw new GitError(
      `git ${args.join(' ')} exited with code ${code}${detail ? `: ${detail}` : ''}`,
      fullArgs,
      code,
      trimmed,
    );
  }
}

/** Buffered variant, for commands with small, bounded output. */
export async function git(cwd: string, args: string[], opts: GitExecOptions = {}): Promise<string> {
  let out = '';
  for await (const chunk of gitStream(cwd, args, opts)) out += chunk;
  return out;
}

/** Buffered variant that returns `null` instead of throwing (e.g. no origin remote). */
export async function gitOrNull(cwd: string, args: string[], opts: GitExecOptions = {}): Promise<string | null> {
  try {
    return await git(cwd, args, opts);
  } catch (err) {
    if (err instanceof GitError) return null;
    throw err;
  }
}
