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
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 0));
  });

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
    throw new GitError(`git ${args.join(' ')} exited with code ${code}`, fullArgs, code, stderr.trim());
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
