import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { globalWorkspaceDir } from './paths.js';

/**
 * The list of repositories NexusMem has been run in on this machine.
 *
 * Cross-project recall needs it because every database is repo-scoped: a
 * query run inside one repo has no way of knowing another repo's memory
 * exists, since `.nexusmem/memory.db` lives under a directory it never looks
 * at. The alternative -- one shared global database -- was rejected for
 * giving up the property that deleting `<repo>/.nexusmem/` removes that
 * repo's memory and nothing else.
 *
 * The registry is therefore an *index*, never a source of truth. Every entry
 * is a pointer that may already be wrong (repo deleted, directory moved), so
 * reads verify the database is still on disk instead of trusting the file.
 */

const ENTRY_SCHEMA = z.object({
  projectId: z.string().min(1),
  root: z.string().min(1),
  dbPath: z.string().min(1),
  originUrl: z.string().nullable().default(null),
  /** Epoch ms of the last `init`/`sync` that recorded this entry. */
  lastSeenAt: z.number().int().nonnegative(),
});

const REGISTRY_SCHEMA = z.object({
  version: z.literal(1),
  projects: z.array(ENTRY_SCHEMA).default([]),
});

export type RegistryEntry = z.infer<typeof ENTRY_SCHEMA>;

export function registryPath(): string {
  return join(globalWorkspaceDir(), 'projects.json');
}

/**
 * Every recorded entry, most recently seen first.
 *
 * A missing, unreadable or corrupt file reads as an empty registry rather
 * than an error: this is a derived index that `sync` rebuilds by being run,
 * and failing a query because a cache file was truncated would be the wrong
 * trade in both directions.
 */
export async function readRegistry(): Promise<RegistryEntry[]> {
  let raw: string;
  try {
    raw = await readFile(registryPath(), 'utf8');
  } catch {
    return [];
  }

  try {
    const parsed = REGISTRY_SCHEMA.safeParse(JSON.parse(raw));
    if (!parsed.success) return [];
    return [...parsed.data.projects].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  } catch {
    return [];
  }
}

export interface LiveRegistry {
  /** Entries whose database is still on disk. */
  entries: RegistryEntry[];
  /** Entries whose database has since disappeared. Reported, never silently dropped from the file. */
  missing: RegistryEntry[];
}

/**
 * The registry split into what can still be searched and what cannot.
 *
 * Stale entries are *not* rewritten out of the file here. A database can be
 * temporarily unreachable -- an unmounted drive, a network share, a repo on a
 * USB disk -- and a query is the wrong moment to decide a project is gone
 * forever. `nexusmem projects --prune` is the explicit way to forget one.
 */
export async function readLiveRegistry(): Promise<LiveRegistry> {
  const all = await readRegistry();
  const entries: RegistryEntry[] = [];
  const missing: RegistryEntry[] = [];

  for (const entry of all) {
    (existsSync(entry.dbPath) ? entries : missing).push(entry);
  }

  return { entries, missing };
}

export interface RecordProjectInput {
  projectId: string;
  root: string;
  dbPath: string;
  originUrl: string | null;
}

/**
 * Add or refresh one project's entry.
 *
 * Keyed by `projectId`, so re-cloning a repository to a new path moves the
 * entry rather than adding a second one -- the same identity rule the store
 * itself uses. Written to a temporary file and renamed, so a crash or a
 * second process mid-write cannot leave a half-written registry behind; two
 * concurrent syncs can still race, and the later writer simply wins.
 */
export async function recordProject(input: RecordProjectInput): Promise<RegistryEntry[]> {
  const existing = await readRegistry();
  const entry: RegistryEntry = { ...input, lastSeenAt: Date.now() };
  const projects = [entry, ...existing.filter((e) => e.projectId !== input.projectId)];

  await writeRegistry(projects);
  return projects;
}

/** Drop entries by project id. Returns how many were removed. */
export async function forgetProjects(projectIds: readonly string[]): Promise<number> {
  const existing = await readRegistry();
  const drop = new Set(projectIds);
  const kept = existing.filter((e) => !drop.has(e.projectId));

  if (kept.length === existing.length) return 0;

  await writeRegistry(kept);
  return existing.length - kept.length;
}

async function writeRegistry(projects: readonly RegistryEntry[]): Promise<void> {
  const path = registryPath();
  const tmp = `${path}.${process.pid}.tmp`;

  await mkdir(globalWorkspaceDir(), { recursive: true });
  await writeFile(tmp, `${JSON.stringify({ version: 1, projects }, null, 2)}\n`, 'utf8');
  await rename(tmp, path);
}
