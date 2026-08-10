import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Same set the production spawn path treats as retryable (`src/git/exec.ts`).
 * Kept as its own copy deliberately: this is fixture scaffolding, and coupling
 * the test harness to a production constant would let a change to one silently
 * alter the other's meaning.
 */
const TRANSIENT_SPAWN_CODES = new Set(['EAGAIN', 'EPERM', 'EACCES', 'EMFILE', 'ENFILE', 'ENOMEM', 'EBUSY', 'ETXTBSY']);

/**
 * Windows NTSTATUS bounds, again a deliberate copy of the production values
 * for the reason above. A process killed by an unhandled exception exits with
 * its NTSTATUS, all of which are >= 0xC0000000, well clear of git's own small
 * exit codes. Ctrl+C is excluded: it is an instruction, not a fault.
 */
const NTSTATUS_FAILURE_BASE = 0xc0000000;
const STATUS_CONTROL_C_EXIT = 0xc000013a;

const DELAYS_MS = [50, 150, 400];

/**
 * Locks a crashed git can leave behind, relative to the repository root.
 *
 * Clearing these is safe *here and only here*. A fixture owns its temp
 * repository outright: one git at a time, run synchronously, in a directory
 * nothing else has a handle on. So a lock found after a crash is provably
 * stale rather than possibly held by a live process, which is exactly the
 * assumption that would be wrong in a user's repository.
 */
const STALE_LOCKS = ['index.lock', 'HEAD.lock', 'config.lock'];

function clearStaleLocks(cwd: string): void {
  for (const lock of STALE_LOCKS) rmSync(join(cwd, '.git', lock), { force: true });
}

interface ExecFailure extends Error {
  code?: string | number;
  status?: number | null;
  stderr?: Buffer | string;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Did the OS kill git, as opposed to git exiting with a verdict of its own?
 *
 * Exported so the classification is assertable. The end-to-end retry cannot
 * be: `gitFixture` runs the real `git` binary, and the crash it exists for is
 * bursty -- measured at roughly two runs in five during one window and zero in
 * sixty a few hours later. A test that waits for a real crash would be the
 * flake it is meant to remove, so the decision is tested and the plumbing that
 * acts on it is kept to one branch.
 */
export function isCrashStatus(status: number | null | undefined): boolean {
  return typeof status === 'number' && status >= NTSTATUS_FAILURE_BASE && status !== STATUS_CONTROL_C_EXIT;
}

/**
 * Run a git command for a test fixture, retrying the failures that are the
 * machine's fault rather than git's.
 *
 * Fixture setup shells out synchronously via `execFileSync`, which never
 * touches `src/git/exec.ts` and therefore gets none of its retry. That gap is
 * not academic: the observed intermittent failures on Windows have been in
 * fixture setup, not in the code under test.
 *
 * Two distinct faults are covered, and the second is why the first was not
 * enough. A spawn failure (`EPERM`/`EAGAIN` from `uv_spawn`) means git never
 * started. A crash means it started and was then torn down mid-write --
 * measured here at 0xC0000005 from `git init` and `git commit`, about two runs
 * in five. Only the spawn case was handled before, so the crash kept the suite
 * red at an unchanged rate and made CI untenable.
 *
 * Unlike production, these commands write, so a crashed attempt can leave a
 * lock behind; `clearStaleLocks` is what makes the retry meaningful rather
 * than a second failure with a different message.
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
      const crashed = isCrashStatus(typeof failure.status === 'number' ? failure.status : null);
      const retryable = crashed || (code !== undefined && TRANSIENT_SPAWN_CODES.has(code));

      if (retryable && attempt < DELAYS_MS.length) {
        if (crashed) clearStaleLocks(cwd);
        sleepSync(DELAYS_MS[attempt]!);
        continue;
      }

      const stderr = failure.stderr?.toString().trim();
      throw new Error(
        `git ${args.join(' ')} failed in ${cwd}` +
          ` [code=${code ?? 'none'} status=${failure.status ?? 'none'}` +
          `${crashed ? ' crashed=yes' : ''} attempts=${attempt + 1}]` +
          (stderr ? `\n${stderr}` : ''),
      );
    }
  }
}
