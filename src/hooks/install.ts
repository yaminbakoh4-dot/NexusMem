import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { hookLogPath, resolvePowerShellProfilePath } from '../shell/paths.js';
import { isHookInstalled, stripHookSnippet, upsertHookSnippet } from './powershell.js';

export interface HookTarget {
  profilePath: string;
  logPath: string;
}

export class ProfileNotFoundError extends Error {
  constructor() {
    super('Could not resolve a PowerShell profile path (tried `powershell -Command $PROFILE`). Pass --profile explicitly.');
    this.name = 'ProfileNotFoundError';
  }
}

export async function resolveHookTarget(profileOverride?: string, logPathOverride?: string): Promise<HookTarget> {
  const profilePath = profileOverride ?? (await resolvePowerShellProfilePath());
  if (!profilePath) throw new ProfileNotFoundError();
  return { profilePath, logPath: logPathOverride ?? hookLogPath() };
}

async function readProfile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

export async function installHook(target: HookTarget): Promise<{ changed: boolean; alreadyInstalled: boolean }> {
  const current = await readProfile(target.profilePath);
  const alreadyInstalled = isHookInstalled(current);
  const next = upsertHookSnippet(current, target.logPath);

  if (next === current) return { changed: false, alreadyInstalled };

  await mkdir(dirname(target.profilePath), { recursive: true });
  await writeFile(target.profilePath, next, 'utf8');
  return { changed: true, alreadyInstalled };
}

export async function removeHook(target: HookTarget): Promise<{ changed: boolean }> {
  const current = await readProfile(target.profilePath);
  if (!isHookInstalled(current)) return { changed: false };

  await writeFile(target.profilePath, stripHookSnippet(current), 'utf8');
  return { changed: true };
}

export async function hookStatus(target: HookTarget): Promise<{ installed: boolean }> {
  const current = await readProfile(target.profilePath);
  return { installed: isHookInstalled(current) };
}
