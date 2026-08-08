import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function psReadLineHistoryPath(): string {
  const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
  return join(appData, 'Microsoft', 'Windows', 'PowerShell', 'PSReadLine', 'ConsoleHost_history.txt');
}

export function bashHistoryPath(): string {
  return process.env.HISTFILE_BASH ?? join(homedir(), '.bash_history');
}

export function zshHistoryPath(): string {
  return process.env.HISTFILE ?? join(homedir(), '.zsh_history');
}

/**
 * The user-scoped (not repo-scoped) NexusMem directory.
 *
 * The hook log lives here rather than under any one repo's `.nexusmem/`,
 * because a shell session moves between projects -- the log is one growing
 * stream shared across every repo, filtered to each repo's cwd at read time.
 */
export function globalWorkspaceDir(): string {
  return join(homedir(), '.nexusmem');
}

export function hookLogPath(): string {
  return join(globalWorkspaceDir(), 'shell-history.jsonl');
}

/**
 * Resolve `$PROFILE` by asking PowerShell itself.
 *
 * The exact path depends on host (Windows PowerShell vs. PowerShell 7) and
 * is not worth hardcoding when the shell will just tell us.
 */
export async function resolvePowerShellProfilePath(exe: 'pwsh' | 'powershell' = 'powershell'): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(exe, ['-NoLogo', '-NoProfile', '-Command', '$PROFILE'], {
      windowsHide: true,
    });
    const path = stdout.trim();
    return path.length > 0 ? path : null;
  } catch {
    return null;
  }
}
