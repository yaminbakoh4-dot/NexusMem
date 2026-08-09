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
 * Stream `git <args>` stdout as UTF-8 chunks.
 *
 * Streaming (rather than buffering) matters here: `git log` over a large repo
 * easily exceeds the default exec buffer, and we want the parser to emit nodes
 * incrementally rather than after the whole history has materialised in RAM.
 */
export async function* gitStream(cwd: string, args: string[]): AsyncGenerator<string> {
  const fullArgs = [...BASE_ARGS, ...args];
  const child = spawn('git', fullArgs, { cwd, windowsHide: true });

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
export async function git(cwd: string, args: string[]): Promise<string> {
  let out = '';
  for await (const chunk of gitStream(cwd, args)) out += chunk;
  return out;
}

/** Buffered variant that returns `null` instead of throwing (e.g. no origin remote). */
export async function gitOrNull(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await git(cwd, args);
  } catch (err) {
    if (err instanceof GitError) return null;
    throw err;
  }
}
