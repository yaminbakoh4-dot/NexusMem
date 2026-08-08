import { makeProjectId } from '../core/project.js';
import { readRepoInfo, type RepoInfo } from '../git/repo.js';
import { readConfig, resolveWorkspace, type NexusConfig, type Workspace } from '../config/workspace.js';

export interface CliContext {
  repo: RepoInfo;
  ws: Workspace;
  projectId: string;
  config: NexusConfig;
}

/**
 * Resolve the repo, its workspace and its config.
 *
 * The project id is always recomputed from the repo rather than trusted from
 * config, so that moving or re-cloning a repo cannot silently split its memory
 * across two namespaces.
 */
export async function loadContext(cwd: string): Promise<CliContext> {
  const repo = await readRepoInfo(cwd);
  const ws = resolveWorkspace(repo.root);
  const config = await readConfig(ws);
  return { repo, ws, projectId: makeProjectId({ root: repo.root, originUrl: repo.originUrl }), config };
}
