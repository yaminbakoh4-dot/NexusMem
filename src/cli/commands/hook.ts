import pc from 'picocolors';
import { hookStatus, installHook, removeHook, resolveHookTarget } from '../../hooks/install.js';

export interface HookOptions {
  profile?: string;
  logPath?: string;
}

export async function runHookInstall(opts: HookOptions): Promise<number> {
  const target = await resolveHookTarget(opts.profile, opts.logPath);
  const result = await installHook(target);

  process.stdout.write(
    [
      result.changed
        ? `${pc.green(result.alreadyInstalled ? 'updated' : 'installed')} shell hook`
        : `${pc.dim('already up to date')}`,
      `  profile ${target.profilePath}`,
      `  log     ${target.logPath}`,
      '',
      `New commands in any PowerShell session using this profile will now log their timestamp, cwd and exit code.`,
      `Open a new PowerShell window (or run \`. $PROFILE\`) for it to take effect.`,
      `Run ${pc.bold('agent-ssd hook remove')} to undo this.`,
      '',
    ].join('\n'),
  );

  return 0;
}

export async function runHookRemove(opts: HookOptions): Promise<number> {
  const target = await resolveHookTarget(opts.profile, opts.logPath);
  const result = await removeHook(target);

  process.stdout.write(
    result.changed
      ? `${pc.green('removed')} shell hook from ${target.profilePath}\n`
      : `${pc.dim('nothing to remove')} — no hook block found in ${target.profilePath}\n`,
  );

  return 0;
}

export async function runHookStatus(opts: HookOptions): Promise<number> {
  const target = await resolveHookTarget(opts.profile, opts.logPath);
  const result = await hookStatus(target);

  process.stdout.write(
    [
      `${pc.dim('profile')} ${target.profilePath}`,
      `${pc.dim('log    ')} ${target.logPath}`,
      `${pc.dim('status ')} ${result.installed ? pc.green('installed') : pc.yellow('not installed')}`,
      '',
    ].join('\n'),
  );

  return 0;
}
