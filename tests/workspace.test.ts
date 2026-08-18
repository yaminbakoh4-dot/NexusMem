import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConfigError,
  defaultConfig,
  isInitialized,
  readConfig,
  resolveWorkspace,
  writeConfig,
  writeWorkspaceGitignore,
} from '../src/config/workspace.js';

/**
 * `readConfig`'s three failure modes (missing file, invalid JSON, schema
 * mismatch) are what a user sees after hand-editing `.nexusmem/config.json`
 * or deleting it -- none of the other test files that call `readConfig` ever
 * hit these branches, since they all read back a config `writeConfig` itself
 * just wrote.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nexusmem-workspace-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('isInitialized', () => {
  it('is false before a config exists', () => {
    expect(isInitialized(resolveWorkspace(dir))).toBe(false);
  });

  it('is true once a config has been written', async () => {
    const ws = resolveWorkspace(dir);
    await writeConfig(ws, defaultConfig('proj-a'));
    expect(isInitialized(ws)).toBe(true);
  });
});

describe('readConfig', () => {
  it('throws ConfigError telling the user to run init when no config exists', async () => {
    const ws = resolveWorkspace(dir);
    await expect(readConfig(ws)).rejects.toThrow(ConfigError);
    await expect(readConfig(ws)).rejects.toThrow(/Not initialized.*nexusmem init/s);
  });

  it('throws ConfigError naming the file when its content is not valid JSON', async () => {
    const ws = resolveWorkspace(dir);
    await writeConfig(ws, defaultConfig('proj-a'));
    writeFileSync(ws.configPath, '{ not json');

    await expect(readConfig(ws)).rejects.toThrow(ConfigError);
    await expect(readConfig(ws)).rejects.toThrow(/not valid JSON/);
  });

  it('throws ConfigError listing the schema issues when JSON is valid but the shape is wrong', async () => {
    const ws = resolveWorkspace(dir);
    await writeConfig(ws, defaultConfig('proj-a'));
    writeFileSync(ws.configPath, JSON.stringify({ version: 2, projectId: '' }));

    await expect(readConfig(ws)).rejects.toThrow(ConfigError);
    await expect(readConfig(ws)).rejects.toThrow(/is invalid/);
  });

  it('round-trips a written config back out with defaults applied', async () => {
    const ws = resolveWorkspace(dir);
    await writeConfig(ws, defaultConfig('proj-a'));

    const read = await readConfig(ws);
    expect(read.projectId).toBe('proj-a');
    expect(read.sources.conversation.enabled).toBe(false);
    expect(read.sources.git.enabled).toBe(true);
  });
});

describe('writeWorkspaceGitignore', () => {
  it('writes a gitignore that ignores everything under the workspace dir', async () => {
    const ws = resolveWorkspace(dir);
    await writeWorkspaceGitignore(ws);

    expect(readFileSync(join(ws.dir, '.gitignore'), 'utf8')).toBe('# Machine-local derived data.\n*\n');
  });
});
