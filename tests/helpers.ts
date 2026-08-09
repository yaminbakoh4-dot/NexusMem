import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';

/**
 * Same set the production spawn path treats as retryable (`src/git/exec.ts`).
 * Kept as its own copy deliberately: this is fixture scaffolding, and coupling
 * the test harness to a production constant would let a change to one silently
 * alter the other's meaning.
 */
const TRANSIENT_SPAWN_CODES = new Set(['EAGAIN', 'EPERM', 'EACCES', 'EMFILE', 'ENFILE', 'ENOMEM', 'EBUSY', 'ETXTBSY']);

const DELAYS_MS = [50, 150, 400];

interface ExecFailure extends Error {
  code?: string | number;
  status?: number | null;
  stderr?: Buffer | string;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run a git command for a test fixture, retrying a transient failure to spawn.
 *
 * Fixture setup shells out synchronously via `execFileSync`, which never
 * touches `src/git/exec.ts` and therefore gets none of its retry. That gap is
 * not academic: the observed intermittent failures on Windows have been in
 * fixture setup (`git init` in a temp dir), not in the code under test.
 *
 * On final failure the errno, exit status and stderr are folded into the
 * message. `execFileSync`'s default "Command failed: git init -q -b main" is
 * identical whether git could not be started or ran and refused, which is
 * exactly the ambiguity that made the original flake hard to attribute.
 */
export function gitFixture(cwd: string, args: string[], options: ExecFileSyncOptions = {}): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      execFileSync('git', args, { cwd, stdio: 'ignore', ...options });
      return;
    } catch (err) {
      const failure = err as ExecFailure;
      const code = typeof failure.code === 'string' ? failure.code : undefined;

      if (code && TRANSIENT_SPAWN_CODES.has(code) && attempt < DELAYS_MS.length) {
        sleepSync(DELAYS_MS[attempt]!);
        continue;
      }

      const stderr = failure.stderr?.toString().trim();
      throw new Error(
        `git ${args.join(' ')} failed in ${cwd}` +
          ` [code=${code ?? 'none'} status=${failure.status ?? 'none'} attempts=${attempt + 1}]` +
          (stderr ? `\n${stderr}` : ''),
      );
    }
  }
}
