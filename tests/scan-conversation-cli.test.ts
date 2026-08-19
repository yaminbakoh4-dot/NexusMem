import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runScanConversation } from '../src/cli/commands/scan-conversation.js';
import { claudeProjectSlug, claudeProjectTranscriptDir } from '../src/conversation/paths.js';
import { readRepoInfo } from '../src/git/repo.js';
import { gitFixture } from './helpers.js';

/**
 * `nexusmem scan-conversation` (`runScanConversation`) had zero test coverage --
 * `tests/conversation.test.ts` only exercises the pure parser, never the real
 * directory listing. `os.homedir()` on win32 reads `USERPROFILE`, which is
 * what lets this point Claude Code's transcript directory at a temp home
 * instead of the real one.
 */

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

let dir: string;
let resolvedRoot: string;
let fakeHome: string;
let stdout: string[];
let stderr: string[];
let prevUserProfile: string | undefined;
let prevHome: string | undefined;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nexusmem-scan-conv-'));
  gitFixture(dir, ['init', '-q', '-b', 'main'], { env: GIT_ENV });
  // git normalizes the temp dir's path (e.g. Windows short-name vs long-name
  // for the parent), and that's the root claudeProjectSlug actually keys off
  // -- resolve it the same way scan-conversation.ts itself does, rather than
  // trusting mkdtempSync's own return value.
  resolvedRoot = (await readRepoInfo(dir)).root;

  fakeHome = mkdtempSync(join(tmpdir(), 'nexusmem-scan-conv-home-'));
  prevUserProfile = process.env.USERPROFILE;
  prevHome = process.env.HOME;
  process.env.USERPROFILE = fakeHome;
  process.env.HOME = fakeHome;

  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(chunk.toString());
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(chunk.toString());
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
  process.env.USERPROFILE = prevUserProfile;
  process.env.HOME = prevHome;
});

function transcriptLine(obj: Record<string, unknown>): string {
  return `${JSON.stringify(obj)}\n`;
}

function writeRealTranscript(): void {
  const transcriptDir = claudeProjectTranscriptDir(resolvedRoot);
  mkdirSync(transcriptDir, { recursive: true });
  const content =
    transcriptLine({
      type: 'user',
      uuid: 'u1',
      timestamp: '2026-08-09T10:00:00.000Z',
      cwd: resolvedRoot,
      message: { role: 'user', content: 'why does this exist' },
    }) +
    transcriptLine({
      type: 'assistant',
      uuid: 'a1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Because it was built for that reason, in real detail.' }] },
    });
  writeFileSync(join(transcriptDir, 'session-1.jsonl'), content);
}

describe('nexusmem scan-conversation', () => {
  it('reports no transcripts found when the Claude Code project dir does not exist', async () => {
    const code = await runScanConversation({ cwd: dir, json: false, minSignal: 0 });

    expect(code).toBe(0);
    expect(stderr.join('')).toContain('no transcripts found');
    expect(stderr.join('')).toContain(claudeProjectSlug(resolvedRoot));
  });

  it('lists a real exchange from a real transcript file on disk', async () => {
    writeRealTranscript();

    const code = await runScanConversation({ cwd: dir, json: false, minSignal: 0 });

    expect(code).toBe(0);
    expect(stderr.join('')).toContain('1 file(s)');
    expect(stdout.join('')).toContain('why does this exist');
  });

  it('--json emits an array of conversation_turn nodes', async () => {
    writeRealTranscript();

    const code = await runScanConversation({ cwd: dir, json: true, minSignal: 0 });

    expect(code).toBe(0);
    const nodes = JSON.parse(stdout.join(''));
    expect(Array.isArray(nodes)).toBe(true);
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes[0].kind).toBe('conversation_turn');
  });
});
