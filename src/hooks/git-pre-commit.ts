/**
 * Generates and detects the block NexusMem inserts into `.git/hooks/pre-commit`
 * to run `nexusmem precheck` before each commit.
 *
 * Unlike the PowerShell profile hook (`hooks/powershell.ts`), a git hook file
 * is a script with a shebang that must be its first line, and is a file real
 * tools (husky, lint-staged, lefthook) actively write to -- see
 * `install-git-precommit.ts` for the foreign-hook handling this module's
 * simple marker scheme enables but does not itself decide.
 *
 * The script deliberately never bakes an absolute path to the `nexusmem`
 * binary (unlike, say, resolving it at install time) -- it checks
 * `command -v nexusmem` at runtime and silently no-ops if it's missing.
 * Simpler and safer for a first pass: a missing binary means no warning
 * printed, never a broken commit. `nexusmem precheck` itself is advisory
 * (exits 0 unless `--strict`), and this hook does not pass `--strict`, so
 * installing it can never block a commit on its own.
 */

const MARK_START = '# >>> nexusmem precommit hook >>>';
const MARK_END = '# <<< nexusmem precommit hook <<<';
const SHEBANG = '#!/bin/sh';

export function renderHookSnippet(): string {
  return [
    MARK_START,
    '# Runs `nexusmem precheck` before each commit -- advisory only, never',
    '# blocks a commit on its own (this hook does not pass --strict).',
    '# Installed by: nexusmem hook git install',
    '# Remove with:  nexusmem hook git remove',
    'if command -v nexusmem >/dev/null 2>&1; then',
    '  nexusmem precheck',
    'fi',
    MARK_END,
    '',
  ].join('\n');
}

export function isHookInstalled(content: string): boolean {
  return content.includes(MARK_START);
}

/** Real, non-empty content with no NexusMem marker -- i.e. a hook this installer did not write. */
export function isForeignHook(content: string): boolean {
  return content.trim().length > 0 && !isHookInstalled(content);
}

export function stripHookSnippet(content: string): string {
  const startIdx = content.indexOf(MARK_START);
  const endIdx = content.indexOf(MARK_END);
  if (startIdx === -1 || endIdx === -1) return content;

  const afterBlock = content.slice(endIdx + MARK_END.length).replace(/^\r?\n/, '');
  return content.slice(0, startIdx) + afterBlock;
}

/**
 * Idempotent, same shape as `powershell.ts`'s `upsertHookSnippet`: strips any
 * existing block first, then appends the current snippet at the end of
 * whatever content remains. Appended, not prepended -- for a foreign hook
 * under `--force` (see `install-git-precommit.ts`), this means the existing
 * hook's own commands still run first, so nexusmem's check never reorders or
 * overrides whatever the existing hook already decided. A foreign hook that
 * calls `exit` early will still prevent this block from ever running -- a
 * known limitation, not silently hidden (see the module-level comment on
 * `installGitHook`).
 */
export function upsertHookSnippet(content: string): string {
  const stripped = stripHookSnippet(content).replace(/\s+$/, '');
  const prefix = stripped.length > 0 ? `${stripped}\n\n` : '';
  return `${prefix}${renderHookSnippet()}`;
}

/** A git hook file's shebang must be its first line; ensure one exists without disturbing existing content. */
export function ensureShebang(content: string): string {
  if (content.startsWith('#!')) return content;
  return content.length > 0 ? `${SHEBANG}\n${content}` : `${SHEBANG}\n`;
}

export { SHEBANG };
