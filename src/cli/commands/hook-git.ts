import pc from 'picocolors';
import { readRepoInfo } from '../../git/repo.js';
import { gitHookStatus, installGitHook, removeGitHook, resolveGitHookTarget } from '../../hooks/install-git-precommit.js';

export interface HookGitOptions {
  cwd: string;
  force?: boolean;
}

export async function runHookGitInstall(opts: HookGitOptions): Promise<number> {
  const repo = await readRepoInfo(opts.cwd);
  const target = resolveGitHookTarget(repo.root);
  const result = await installGitHook(target, { force: opts.force });

  const lines = [
    result.changed
      ? `${pc.green(result.alreadyInstalled ? 'updated' : 'installed')} git pre-commit hook`
      : `${pc.dim('already up to date')}`,
    `  hook ${target.hookPath}`,
  ];
  if (result.appendedToForeign) {
    lines.push(`  ${pc.yellow('appended after an existing pre-commit hook -- review')} ${target.hookPath}`);
  }
  lines.push(
    '',
    `Runs ${pc.bold('nexusmem precheck')} before each commit -- advisory only, never blocks a commit on its own.`,
    `Run ${pc.bold('nexusmem hook git remove')} to undo this.`,
    '',
  );

  process.stdout.write(lines.join('\n'));

  return 0;
}

export async function runHookGitRemove(opts: HookGitOptions): Promise<number> {
  const repo = await readRepoInfo(opts.cwd);
  const target = resolveGitHookTarget(repo.root);
  const result = await removeGitHook(target);

  process.stdout.write(
    result.changed
      ? `${pc.green('removed')} nexusmem's block from ${target.hookPath}\n`
      : `${pc.dim('nothing to remove')} — no nexusmem block found in ${target.hookPath}\n`,
  );

  return 0;
}

export async function runHookGitStatus(opts: HookGitOptions): Promise<number> {
  const repo = await readRepoInfo(opts.cwd);
  const target = resolveGitHookTarget(repo.root);
  const result = await gitHookStatus(target);

  const statusLabel = result.installed
    ? pc.green('installed')
    : result.foreign
      ? pc.yellow('a foreign hook exists (not nexusmem) -- install --force to append')
      : pc.yellow('not installed');

  process.stdout.write([`${pc.dim('hook  ')} ${target.hookPath}`, `${pc.dim('status')} ${statusLabel}`, ''].join('\n'));

  return 0;
}
