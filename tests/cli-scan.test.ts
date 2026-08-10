import { describe, expect, it } from 'vitest';
import { summarize } from '../src/cli/commands/scan-git.js';
import {
  CONVERSATION_SIGNAL_BANDS,
  DOCS_SIGNAL_BANDS,
  formatSignal,
  GIT_SIGNAL_BANDS,
  SHELL_SIGNAL_BANDS,
  signalBand,
  type SignalBands,
} from '../src/cli/format.js';
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

/**
 * `scan-git`, `scan-shell`, `scan-conversation` and `scan-docs` each used to
 * carry a private `signalColor`. They had drifted: `scan-shell` graded high
 * signal red where the other three graded it green, so the leading column of
 * the same report meant opposite things depending on the subcommand.
 *
 * The cutoffs legitimately differ (collectors do not score on one scale), so
 * these assert the thresholds per source and the shared color language once.
 */
describe('signal formatting', () => {
  const ALL: Array<[string, SignalBands]> = [
    ['git', GIT_SIGNAL_BANDS],
    ['shell', SHELL_SIGNAL_BANDS],
    ['conversation', CONVERSATION_SIGNAL_BANDS],
    ['docs', DOCS_SIGNAL_BANDS],
  ];

  it.each(ALL)('bands %s signals at its own cutoffs, inclusive at the boundary', (_name, bands) => {
    expect(signalBand(bands.high, bands)).toBe('high');
    expect(signalBand(bands.high + 0.01, bands)).toBe('high');
    expect(signalBand(bands.high - 0.01, bands)).toBe('medium');
    expect(signalBand(bands.medium, bands)).toBe('medium');
    expect(signalBand(bands.medium - 0.01, bands)).toBe('low');
    expect(signalBand(0, bands)).toBe('low');
    expect(signalBand(1, bands)).toBe('high');
  });

  it('keeps the cutoffs ordered for every source', () => {
    for (const [name, bands] of ALL) {
      expect(bands.high, `${name} high must exceed medium`).toBeGreaterThan(bands.medium);
    }
  });

  /**
   * Colour-blind by necessity: picocolors emits no escape codes under a
   * non-TTY runner, so this cannot assert "green". What it can assert is that
   * all four sources render an equally-banded signal identically -- which is
   * the property that actually broke. It holds by construction now (one
   * BAND_COLOR map), and this pins that it stays that way.
   */
  it('renders the same band identically across every source', () => {
    for (const band of ['high', 'medium', 'low'] as const) {
      const pick = { high: 0.99, medium: 0.42, low: 0.01 }[band];
      const rendered = ALL.map(([, bands]) => (signalBand(pick, bands) === band ? formatSignal(pick, bands) : null));
      const comparable = rendered.filter((r): r is string => r !== null);
      expect(new Set(comparable).size, `${band} renders differently across sources`).toBe(1);
    }
  });

  it('always renders two decimal places', () => {
    expect(formatSignal(0.5, GIT_SIGNAL_BANDS)).toContain('0.50');
    expect(formatSignal(1, GIT_SIGNAL_BANDS)).toContain('1.00');
  });
});
