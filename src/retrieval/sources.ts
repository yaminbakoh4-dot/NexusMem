import { basename } from 'node:path';
import { readLiveRegistry, type RegistryEntry } from '../config/registry.js';
import { MemoryStore } from '../store/store.js';
import type { QuerySource } from './query-pipeline.js';

/**
 * Turning the registry into a set of open databases to search.
 *
 * Every failure mode here is non-fatal by design: a cross-project query that
 * refuses to answer because one of six repositories is on an unplugged drive
 * would be worse than one that answers from five and says so.
 */

export interface OpenedSources {
  sources: QuerySource[];
  /** Registered projects whose database file is not currently on disk. */
  missing: RegistryEntry[];
  /** Registered projects whose database exists but could not be opened. */
  unreadable: Array<{ entry: RegistryEntry; reason: string }>;
  close(): void;
}

export interface CurrentProject {
  projectId: string;
  root: string;
  dbPath: string;
}

/**
 * Open the current repository plus every other registered one.
 *
 * The current project is included even when the registry has never heard of
 * it -- a repo initialized before the registry existed would otherwise be
 * missing from its own query.
 */
export async function openAllProjectSources(current: CurrentProject): Promise<OpenedSources> {
  const { entries, missing } = await readLiveRegistry();

  const wanted: CurrentProject[] = [current];
  for (const entry of entries) {
    if (entry.projectId === current.projectId) continue;
    wanted.push({ projectId: entry.projectId, root: entry.root, dbPath: entry.dbPath });
  }

  const labels = labelProjects(wanted);
  const sources: QuerySource[] = [];
  const unreadable: OpenedSources['unreadable'] = [];

  wanted.forEach((project, index) => {
    try {
      sources.push({
        store: MemoryStore.open(project.dbPath),
        projectId: project.projectId,
        label: labels[index] ?? project.projectId.slice(0, 8),
      });
    } catch (err) {
      // Never the current project's database: `loadContext` has already
      // opened that one by the time this runs.
      const entry = entries.find((e) => e.projectId === project.projectId);
      if (entry) unreadable.push({ entry, reason: (err as Error).message });
    }
  });

  return {
    sources,
    missing,
    unreadable,
    close: () => {
      for (const source of sources) source.store.close();
    },
  };
}

/**
 * Short, unique names for a set of projects.
 *
 * A directory basename is what a person calls their repo, so it is the right
 * label right up until two of them are called `api`. Collisions get the head
 * of the project id appended rather than the full path: the label is a
 * disambiguator in a context block, not an address.
 */
export function labelProjects(projects: readonly CurrentProject[]): string[] {
  const counts = new Map<string, number>();
  for (const project of projects) {
    const name = basename(project.root) || project.root;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  return projects.map((project) => {
    const name = basename(project.root) || project.root;
    return (counts.get(name) ?? 0) > 1 ? `${name}#${project.projectId.slice(0, 6)}` : name;
  });
}
