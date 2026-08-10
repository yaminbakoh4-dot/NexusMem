import { describe, expect, it } from 'vitest';
import { summarize } from '../src/cli/commands/scan-git.js';
import { approxTokens } from '../src/core/text.js';
import type { MemoryNode } from '../src/core/types.js';

/**
 * `scan-git`, `scan-shell`, `scan-conversation` and `scan-docs` all print the
 * same label -- "~N tokens if sent raw" -- as the headline number a user reads
 * to judge how much context NexusMem is saving them.
 *
 * Three of the four import `approxTokens` from `core/text.ts`. `scan-git`
 * reimplements it inline as `Math.round(totalChars / 4)`, which is not the same
 * function: the shared helper is `Math.ceil` applied *per node*, so the two
 * diverge on any corpus of more than one node. Same label, different arithmetic.
 */

function node(body: string): MemoryNode {
  return {
    id: body.slice(0, 8),
    kind: 'git_commit',
    projectId: 'proj',
    ts: '2026-08-01T00:00:00Z',
    source: 'git',
    title: 'feat: something',
    body,
    files: [],
    signal: 0.5,
    meta: {},
  };
}

/** Pull the "~N tokens" figure back out of the rendered (colored) summary. */
function reportedTokens(rendered: string): number {
  const match = /~([\d,]+) tokens/.exec(rendered);
  if (!match) throw new Error(`no token figure in summary: ${JSON.stringify(rendered)}`);
  return Number(match[1]!.replace(/,/g, ''));
}

describe('scan-git summary', () => {
  it('reports the same token total as the shared approxTokens helper', () => {
    const nodes = [node('x'.repeat(5)), node('y'.repeat(5)), node('z'.repeat(5)), node('w'.repeat(101))];
    const expected = nodes.reduce((n, x) => n + approxTokens(x.body), 0);

    expect(reportedTokens(summarize(nodes))).toBe(expected);
  });

  it('agrees with the shared helper on a single node too', () => {
    const nodes = [node('a'.repeat(4001))];
    expect(reportedTokens(summarize(nodes))).toBe(approxTokens(nodes[0]!.body));
  });
});
