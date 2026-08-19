import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runScanSession } from '../src/cli/commands/scan-session.js';
import { claudeProjectTranscriptDir } from '../src/conversation/paths.js';
import { readRepoInfo } from '../src/git/repo.js';
import { gitFixture } from './helpers.js';

/**
 * `nexusmem scan-session` (`runScanSession`) had zero test coverage. Only the
 * `--dry-run` and no-transcripts paths are covered here -- the real
 * summarization path constructs `new OllamaChatProvider(...)` inline (not
 * injectable) and needs a live Ollama, which tests/slm-provider.test.ts
 * already covers separately.
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
  dir = mkdtempSync(join(tmpdir(), 'nexusmem-scan-session-'));
  gitFixture(dir, ['init', '-q', '-b', 'main'], { env: GIT_ENV });
  resolvedRoot = (await readRepoInfo(dir)).root;

  fakeHome = mkdtempSync(join(tmpdir(), 'nexusmem-scan-session-home-'));
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

function writeSettledTranscript(): void {
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

describe('nexusmem scan-session', () => {
  it('reports no transcripts found when the Claude Code project dir does not exist', async () => {
    const code = await runScanSession({ cwd: dir, model: 'qwen2.5:3b', settleMinutes: 30, maxSessions: 10, dryRun: true, json: false });

    expect(code).toBe(0);
    expect(stderr.join('')).toContain('no transcripts found');
  });

  it('--dry-run reports the session as settled and prints its prompt, without calling a model', async () => {
    writeSettledTranscript();

    const code = await runScanSession({ cwd: dir, model: 'qwen2.5:3b', settleMinutes: 30, maxSessions: 10, dryRun: true, json: false });

    expect(code).toBe(0);
    expect(stderr.join('')).toContain('1 found, 1 settled');
    expect(stdout.join('')).toContain('why does this exist');
  });

  it('--dry-run --json emits an array of prompt previews with a hash', async () => {
    writeSettledTranscript();

    const code = await runScanSession({ cwd: dir, model: 'qwen2.5:3b', settleMinutes: 30, maxSessions: 10, dryRun: true, json: true });

    expect(code).toBe(0);
    const previews = JSON.parse(stdout.join(''));
    expect(Array.isArray(previews)).toBe(true);
    expect(previews).toHaveLength(1);
    expect(typeof previews[0].hash).toBe('string');
    expect(previews[0].prompt).toContain('why does this exist');
  });

  it('--dry-run respects maxSessions, previewing at most that many settled sessions', async () => {
    writeSettledTranscript();

    const code = await runScanSession({ cwd: dir, model: 'qwen2.5:3b', settleMinutes: 30, maxSessions: 0, dryRun: true, json: true });

    expect(code).toBe(0);
    const previews = JSON.parse(stdout.join(''));
    expect(previews).toHaveLength(0);
  });
});
