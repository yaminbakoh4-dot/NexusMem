import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ensureShebang, isForeignHook, isHookInstalled, SHEBANG, stripHookSnippet, upsertHookSnippet } from './git-pre-commit.js';

export interface GitHookTarget {
  hookPath: string;
}

/**
 * `.git/hooks/pre-commit` already has real, non-NexusMem content -- a real
 * tool (husky, lint-staged, lefthook) commonly owns this exact file. Refusing
 * by default and requiring `--force` mirrors how `sync --prune-source`
 * requires `--yes` for an action a typo could make irreversible-feeling: an
 * unreviewed overwrite of someone else's hook is exactly that kind of
 * surprise.
 */
export class ForeignGitHookError extends Error {
  constructor(readonly hookPath: string) {
    super(
      `${hookPath} already has a pre-commit hook NexusMem did not install. ` +
        'Pass --force to append nexusmem\'s check to the end of it, or integrate manually.',
    );
    this.name = 'ForeignGitHookError';
  }
}

export function resolveGitHookTarget(repoRoot: string): GitHookTarget {
  return { hookPath: join(repoRoot, '.git', 'hooks', 'pre-commit') };
}

async function readHook(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

export interface InstallGitHookResult {
  changed: boolean;
  alreadyInstalled: boolean;
  /** True when this install appended onto a pre-existing foreign hook under `--force`. */
  appendedToForeign: boolean;
}

export async function installGitHook(target: GitHookTarget, opts: { force?: boolean } = {}): Promise<InstallGitHookResult> {
  const current = await readHook(target.hookPath);
  const alreadyInstalled = isHookInstalled(current);
  const foreign = isForeignHook(current);

  if (foreign && !alreadyInstalled && !opts.force) {
    throw new ForeignGitHookError(target.hookPath);
  }

  // Shebang applied *before* upsert, not after: upsertHookSnippet measures
  // "prior content" to decide the blank-line separator before its block, and
  // that measurement has to be stable across calls. Applying ensureShebang
  // afterward meant the very first install (no shebang in the prior content)
  // formatted differently from every later one (shebang now part of the
  // prior content) -- a real idempotency bug caught by exactly the "second
  // install is a no-op" test this is written to satisfy.
  const next = upsertHookSnippet(ensureShebang(current));
  if (next === current) return { changed: false, alreadyInstalled, appendedToForeign: false };

  await mkdir(dirname(target.hookPath), { recursive: true });
  await writeFile(target.hookPath, next, 'utf8');
  // Best-effort: NTFS (Windows) ignores unix mode bits entirely, and git for
  // Windows runs hooks via its bundled sh.exe regardless -- POSIX systems do
  // need the executable bit, so this is set unconditionally rather than
  // gated on platform detection.
  await chmod(target.hookPath, 0o755).catch(() => {});

  return { changed: true, alreadyInstalled, appendedToForeign: foreign && !alreadyInstalled };
}

export async function removeGitHook(target: GitHookTarget): Promise<{ changed: boolean }> {
  const current = await readHook(target.hookPath);
  if (!isHookInstalled(current)) return { changed: false };

  const stripped = stripHookSnippet(current).trim();
  // Nothing left but the shebang this installer itself added (or nothing at
  // all) -- delete the file rather than leave a no-op executable behind.
  if (stripped === '' || stripped === SHEBANG) {
    await unlink(target.hookPath).catch(() => {});
  } else {
    await writeFile(target.hookPath, `${stripped}\n`, 'utf8');
  }

  return { changed: true };
}

export async function gitHookStatus(target: GitHookTarget): Promise<{ installed: boolean; foreign: boolean }> {
  const current = await readHook(target.hookPath);
  return { installed: isHookInstalled(current), foreign: isForeignHook(current) };
}
