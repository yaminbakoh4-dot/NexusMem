import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runProjects } from '../src/cli/commands/projects.js';
import { recordProject } from '../src/config/registry.js';
import { MemoryStore } from '../src/store/store.js';

/**
 * `runProjects` writes straight to `process.stdout`/`process.stderr` rather
 * than through an injected `out` callback (unlike `runStatus`/`runPrecheck`),
 * so these spy on the two streams instead. Always restored in `afterEach` --
 * see `tests/mcp.test.ts`'s "never reassigns process.stdout.write" test for
 * why a *leaked* reassignment specifically would be a real bug elsewhere.
 */

let dir: string;
let home: string;
let previousHome: string | undefined;
let stdout: string[];
let stderr: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nexusmem-projects-cli-'));
  // A fresh registry per test, same isolation tests/cross-project.test.ts
  // uses -- without it, every `it()` here shares the one registry
  // tests/setup.ts points at for the whole suite, and node/missing counts
  // accumulate across cases instead of starting from zero.
  home = mkdtempSync(join(tmpdir(), 'nexusmem-projects-cli-home-'));
  previousHome = process.env.NEXUSMEM_HOME;
  process.env.NEXUSMEM_HOME = home;

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
  if (previousHome === undefined) delete process.env.NEXUSMEM_HOME;
  else process.env.NEXUSMEM_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
  // Best-effort: the "unopenable database" case deliberately points
  // MemoryStore.open at a non-sqlite file, and on Windows a failed
  // better-sqlite3 open can leave the file handle held a moment longer
  // than the constructor call, which turns an immediate rmSync into EPERM.
  // Nothing under `dir` outlives the OS temp directory either way.
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignored -- see above
  }
});

function entry(name: string) {
  return {
    projectId: `proj-${name}`,
    root: join(dir, name),
    dbPath: join(dir, `${name}.db`),
    originUrl: null,
  };
}

describe('nexusmem projects', () => {
  it('reports "no projects registered" against an empty registry', async () => {
    const code = await runProjects({ prune: false, json: false });

    expect(code).toBe(0);
    expect(stderr.join('')).toContain('no projects registered');
  });

  it('lists a registered project with its node count, via --json', async () => {
    const alpha = entry('alpha');
    MemoryStore.open(alpha.dbPath).close();
    await recordProject(alpha);

    const store = MemoryStore.open(alpha.dbPath);
    store.upsertNodes([
      {
        id: 'n1',
        kind: 'git_commit',
        projectId: alpha.projectId,
        ts: '2026-01-01T00:00:00Z',
        source: 'git',
        title: 'feat: x',
        body: 'feat: x',
        files: [],
        signal: 0.5,
        meta: {},
      },
    ]);
    store.close();

    const code = await runProjects({ prune: false, json: true });
    expect(code).toBe(0);

    const parsed = JSON.parse(stdout.join(''));
    expect(parsed.projects).toHaveLength(1);
    expect(parsed.projects[0]).toMatchObject({ projectId: alpha.projectId, nodes: 1 });
    expect(parsed.missing).toEqual([]);
  });

  it('reports a present-but-unopenable database as null nodes, not zero', async () => {
    const broken = entry('broken');
    writeFileSync(broken.dbPath, 'not a sqlite file');
    await recordProject(broken);

    const code = await runProjects({ prune: false, json: true });
    expect(code).toBe(0);

    const parsed = JSON.parse(stdout.join(''));
    expect(parsed.projects[0]).toMatchObject({ projectId: broken.projectId, nodes: null });
  });

  it('lists a registered project whose database is gone under missing, not projects', async () => {
    await recordProject(entry('ghost'));

    const code = await runProjects({ prune: false, json: true });
    expect(code).toBe(0);

    const parsed = JSON.parse(stdout.join(''));
    expect(parsed.projects).toEqual([]);
    expect(parsed.missing).toHaveLength(1);
    expect(parsed.missing[0].projectId).toBe('proj-ghost');
  });

  it('--prune forgets projects whose database is gone and reports how many', async () => {
    await recordProject(entry('ghost'));

    const code = await runProjects({ prune: true, json: true });
    expect(code).toBe(0);
    // Not `toContain('pruned 1 project(s)')` as one string: pc.yellow('pruned')
    // colors only that word, leaving an ANSI reset code between it and the count.
    expect(stderr.join('')).toContain('pruned');
    expect(stderr.join('')).toContain('1 project(s) whose database is gone');
    // `missing` in the JSON is a snapshot from before the prune ran, not a
    // re-read after -- this run reports the one entry it just removed, same
    // as the "pruned 1" line above. The next run is where it's actually gone.
    expect(JSON.parse(stdout.join('')).missing).toHaveLength(1);

    stdout.length = 0;
    stderr.length = 0;

    // The prune sweep itself removed the ghost entry from the registry, so a
    // second run has nothing left to prune -- confirms the removal was real,
    // not just left out of the first run's own report.
    const second = await runProjects({ prune: true, json: true });
    expect(second).toBe(0);
    expect(stderr.join('')).toContain('0 project(s) whose database is gone');
  });
});
