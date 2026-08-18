import pc from 'picocolors';
import { MemoryStore } from '../../store/store.js';
import { loadContext } from '../context.js';

export class MarkStaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarkStaleError';
  }
}

export interface MarkStaleOptions {
  cwd: string;
  /** Id of the node being marked stale. */
  nodeId: string;
  /** Id of the node that supersedes it. */
  supersedesId: string;
  out?: (chunk: string) => void;
}

/**
 * `nexusmem mark-stale <nodeId> --supersedes <newNodeId>`. Writes
 * `newNodeId.supersedes = nodeId`; the ranker down-weights `nodeId` from then
 * on but never deletes it. No automatic staleness detection -- a human or
 * agent has to notice the contradiction and run this. Both ids must belong
 * to the current project.
 */
export async function runMarkStale(opts: MarkStaleOptions): Promise<number> {
  const { projectId, ws } = await loadContext(opts.cwd);
  const out = opts.out ?? ((chunk: string) => void process.stdout.write(chunk));

  if (opts.nodeId === opts.supersedesId) {
    throw new MarkStaleError('a node cannot supersede itself');
  }

  const store = MemoryStore.open(ws.dbPath);
  try {
    const staleProject = store.getNodeProjectId(opts.nodeId);
    if (staleProject === null) {
      throw new MarkStaleError(`no node found with id ${opts.nodeId}`);
    }
    const supersedingProject = store.getNodeProjectId(opts.supersedesId);
    if (supersedingProject === null) {
      throw new MarkStaleError(`no node found with id ${opts.supersedesId}`);
    }
    if (staleProject !== projectId || supersedingProject !== projectId) {
      throw new MarkStaleError('both nodes must belong to the current project');
    }

    store.setSupersedes(opts.supersedesId, opts.nodeId);
    out(
      `${pc.green('marked stale')} ${opts.nodeId}\n` +
        `${pc.dim('superseded by')} ${opts.supersedesId} -- the old node stays queryable, just ranked lower\n`,
    );
    return 0;
  } finally {
    store.close();
  }
}
