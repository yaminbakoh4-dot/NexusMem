import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInit } from '../src/cli/commands/init.js';
import { runStatus } from '../src/cli/commands/status.js';
import { runSync } from '../src/cli/commands/sync.js';
import { LATEST_SCHEMA_VERSION } from '../src/store/schema.js';
import { gitFixture } from './helpers.js';

/**
 * `tests/status.test.ts` only covers the stale-project-identity branch of
 * `runStatus`. The rest of the report -- schema line, "no sources synced
 * yet" before a first sync, the real sources list with a git cursor, and
 * the structure line -- had no coverage. Chains is deliberately not covered
 * here: reproducing it needs a real failure/retry pair, which is out of
 * scope for what this file sets out to close.
 */

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

// picocolors wraps individual words in escape codes, so a literal substring
// or regex match against adjacent words (e.g. "git" padding next to a
// separately pc.dim-wrapped "last run") can fail even though they're
// adjacent on screen. Only shows up where CI forces color on and a local
// dev run doesn't -- see tests/forget.test.ts's own copy of this helper.
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nexusmem-status-report-'));
  const git = (...args: string[]) => gitFixture(dir, args, { env: GIT_ENV });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.ts'), "import { b } from './b.js';\nexport const a = b;\n");
  writeFileSync(join(dir, 'b.ts'), 'export const b = 1;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'chore: initial commit');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function statusOutput(): Promise<string> {
  const chunks: string[] = [];
  await runStatus({ cwd: dir, out: (chunk) => chunks.push(chunk) });
  return stripAnsi(chunks.join(''));
}

describe('status report body', () => {
  it('reports "no sources synced yet" before any sync has run', async () => {
    await runInit({ cwd: dir, force: false, hook: false, enableConversation: false, out: () => {} });

    const output = await statusOutput();
    expect(output).toContain('no sources synced yet');
    expect(output).toContain(`schema`);
    expect(output).toContain(`v${LATEST_SCHEMA_VERSION}`);
  });

  it('lists real sources with cursors and the structure edge count after a sync', async () => {
    await runInit({ cwd: dir, force: false, hook: false, enableConversation: false, out: () => {} });
    await runSync({ cwd: dir, full: true, rebuild: false, noEmbed: true, quiet: true, out: () => {} });

    const output = await statusOutput();
    expect(output).toContain('sources');
    expect(output).toMatch(/git\s+last run/);
    expect(output).not.toContain('no sources synced yet');
    expect(output).toMatch(/structure\s+1 import edge\(s\) across 1 file\(s\)/);
    // Just-synced HEAD, so no "behind HEAD" nudge.
    expect(output).not.toContain('git behind HEAD');
  });

  it('warns that git is behind HEAD when a new commit lands after the last sync', async () => {
    await runInit({ cwd: dir, force: false, hook: false, enableConversation: false, out: () => {} });
    await runSync({ cwd: dir, full: true, rebuild: false, noEmbed: true, quiet: true, out: () => {} });

    writeFileSync(join(dir, 'c.txt'), 'new\n');
    gitFixture(dir, ['add', '.'], { env: GIT_ENV });
    gitFixture(dir, ['commit', '-q', '-m', 'chore: a commit sync has not seen yet'], { env: GIT_ENV });

    const output = await statusOutput();
    expect(output).toContain('git behind HEAD');
    expect(output).toContain('nexusmem sync');
  });
});
