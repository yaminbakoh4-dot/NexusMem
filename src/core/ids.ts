import { createHash } from 'node:crypto';
import type { NodeKind } from './types.js';

/** NUL cannot appear in any of our key components, so it is a safe joiner. */
const KEY_SEP = '\u0000';

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Content-addressed node id.
 *
 * `naturalKey` must be whatever uniquely identifies the event at its source
 * (a commit sha, a `timestamp:command` pair, ...). Re-running `sync` then
 * re-derives the exact same id, which makes ingestion idempotent without
 * relying on a cursor being correct.
 */
export function makeNodeId(projectId: string, kind: NodeKind, naturalKey: string): string {
  return sha256Hex([projectId, kind, naturalKey].join(KEY_SEP)).slice(0, 24);
}
