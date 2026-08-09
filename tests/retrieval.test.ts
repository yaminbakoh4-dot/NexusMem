import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MemoryNode } from '../src/core/types.js';
import { packContext, renderContextBlock } from '../src/retrieval/pack.js';
import { rankHits, type RankedHit } from '../src/retrieval/rank.js';
import type { SearchHit } from '../src/store/store.js';
import { MemoryStore } from '../src/store/store.js';

const NOW = new Date('2026-08-08T00:00:00Z');

function hit(overrides: Partial<SearchHit> & Pick<SearchHit, 'id'>): SearchHit {
  return {
    kind: 'git_commit',
    ts: '2026-08-01T00:00:00Z',
    title: 'feat: something',
    body: 'feat: something\n\nmore detail',
    signal: 0.5,
    rank: -2,
    ...overrides,
  };
}

describe('rankHits', () => {
  it('returns [] for no hits without dividing by zero', () => {
    expect(rankHits([])).toEqual([]);
  });

  it('ranks a stronger bm25 match above a weaker one, all else equal', () => {
    const ranked = rankHits([hit({ id: 'weak', rank: -1 }), hit({ id: 'strong', rank: -5 })], { now: NOW });
    expect(ranked.map((r) => r.id)).toEqual(['strong', 'weak']);
    expect(ranked[0]!.relevance).toBeGreaterThan(ranked[1]!.relevance);
  });

  it('uses signal to break relevance ties', () => {
    const ranked = rankHits(
      [
        hit({ id: 'chore', rank: -2, signal: 0.2, ts: NOW.toISOString() }),
        hit({ id: 'fix', rank: -2, signal: 0.9, ts: NOW.toISOString() }),
      ],
      { now: NOW },
    );
    expect(ranked.map((r) => r.id)).toEqual(['fix', 'chore']);
  });

  it('decays older nodes below newer ones at equal relevance and signal', () => {
    const old = new Date(NOW.getTime() - 90 * 86_400_000).toISOString();
    const ranked = rankHits(
      [hit({ id: 'old', rank: -2, ts: old }), hit({ id: 'new', rank: -2, ts: NOW.toISOString() })],
      { now: NOW, halfLifeDays: 30 },
    );
    expect(ranked.map((r) => r.id)).toEqual(['new', 'old']);
    expect(ranked[1]!.recencyFactor).toBeGreaterThanOrEqual(0.3); // floor, never zero
  });

  it('never lets one factor crush the others to exactly zero', () => {
    const veryOld = new Date(NOW.getTime() - 5000 * 86_400_000).toISOString();
    const ranked = rankHits([hit({ id: 'ancient', rank: -2, signal: 0.05, ts: veryOld })], { now: NOW });
    expect(ranked[0]!.score).toBeGreaterThan(0);
  });

  it('gives every hit relevance 1 when all bm25 costs are identical', () => {
    const ranked = rankHits([hit({ id: 'a', rank: -3 }), hit({ id: 'b', rank: -3 })], { now: NOW });
    expect(ranked.every((r) => r.relevance === 1)).toBe(true);
  });
});

/**
 * The priors (signal, recency) are bounded relative to relevance: across their
 * whole range they may overturn at most a 2x relevance gap. These pin that
 * boundary from both sides, so a future weight change cannot quietly move it.
 *
 * `relevanceScores` is used rather than bm25 `rank` because it is the only way
 * to place a hit at a *chosen* relevance: both paths min-max rescale into
 * [0.15, 1], so with two hits the gap is always maximal. The third hit anchors
 * the bottom of that rescale.
 */
describe('rankHits — prior vs relevance balance', () => {
  const AT_NOW = NOW.toISOString();

  /** Build hits whose post-normalization relevance lands on `targets`. */
  function withRelevance(targets: Array<{ id: string; relevance: number; signal: number }>) {
    const scores = new Map<string, number>();
    for (const t of targets) scores.set(t.id, (t.relevance - 0.15) / 0.85);
    scores.set('_anchor', 0); // pins min so the rescale is the identity above

    const hits = [
      ...targets.map((t) => hit({ id: t.id, signal: t.signal, ts: AT_NOW })),
      hit({ id: '_anchor', signal: 0.5, ts: AT_NOW }),
    ];
    return rankHits(hits, { now: NOW, relevanceScores: scores });
  }

  it('lets max signal overturn a relevance gap below 2x', () => {
    const ranked = withRelevance([
      { id: 'relevant', relevance: 1.0, signal: 0 }, // signalWeight 0.2 (worst)
      { id: 'important', relevance: 0.6, signal: 1 }, // signalWeight 1.0 (best), gap 1.67x
    ]);
    expect(ranked[0]!.id).toBe('important');
  });

  it('does not let max signal overturn a relevance gap above 2x', () => {
    const ranked = withRelevance([
      { id: 'relevant', relevance: 1.0, signal: 0 },
      { id: 'important', relevance: 0.4, signal: 1 }, // gap 2.5x
    ]);
    expect(ranked[0]!.id).toBe('relevant');
  });

  it('keeps the top-matching doc above a higher-signal commit (the dogfooded regression)', () => {
    // Reproduces the observed production pair: a `fix:` commit (signal .9) beat
    // the top-fused README section (signal .55) on signal alone, despite a 15%
    // relevance deficit and identical recency.
    const ranked = withRelevance([
      { id: 'doc', relevance: 1.0, signal: 0.55 },
      { id: 'commit', relevance: 0.847, signal: 0.9 },
    ]);
    expect(ranked[0]!.id).toBe('doc');
  });

  it('still reports the raw, un-exponentiated factors for display', () => {
    const ranked = withRelevance([{ id: 'a', relevance: 1.0, signal: 0.5 }]);
    const a = ranked.find((r) => r.id === 'a')!;
    expect(a.signalWeight).toBeCloseTo(0.6, 5); // 0.2 + 0.8 * 0.5
    expect(a.score).toBeLessThan(a.relevance); // but scoring discounted it
  });
});

function ranked(overrides: Partial<RankedHit> & Pick<RankedHit, 'id'>): RankedHit {
  const base = hit(overrides);
  return { ...base, relevance: 1, signalWeight: 1, recencyFactor: 1, ageDays: 0, score: 1, ...overrides };
}

describe('packContext', () => {
  it('never exceeds the token budget', () => {
    const hits = Array.from({ length: 20 }, (_, i) =>
      ranked({ id: `n${i}`, score: 1 - i * 0.01, body: 'x'.repeat(400) }),
    );
    const result = packContext(hits, 200);
    expect(result.tokensUsed).toBeLessThanOrEqual(200);
  });

  it('includes the highest-score hits first', () => {
    // packContext trusts its input is already sorted (rankHits's job) --
    // pass it pre-sorted, as real callers do.
    const hits = [
      ranked({ id: 'high', score: 0.9, body: 'small body' }),
      ranked({ id: 'low', score: 0.1, body: 'small body' }),
    ];
    const result = packContext(hits, 1000);
    expect(result.nodes[0]!.id).toBe('high');
  });

  it('skips a big node that does not fit and still packs a smaller lower-score one', () => {
    const hits = [
      ranked({ id: 'big', score: 0.9, title: 'big', body: 'y'.repeat(4000) }),
      ranked({ id: 'small', score: 0.5, title: 'small', body: 'tiny' }),
    ];
    const result = packContext(hits, 50);
    expect(result.nodes.map((n) => n.id)).toEqual(['small']);
    expect(result.droppedForBudget).toBe(1);
  });

  it('reports how many candidates were considered', () => {
    const hits = [ranked({ id: 'a' }), ranked({ id: 'b' })];
    expect(packContext(hits, 5).consideredNodes).toBe(2);
  });

  it('drops the title from the summary when the body repeats it', () => {
    const h = ranked({ id: 'a', title: 'fix: thing', body: 'fix: thing\n\nreal explanation here' });
    const result = packContext([h], 1000);
    expect(result.nodes[0]!.summary).toBe('real explanation here');
  });

  it('summarizes a conversation node from its answer, not its (possibly long) repeated question', () => {
    const longQuestion = 'why floors on ranking factor score '.repeat(20); // long enough to eat a 320-char summary alone
    const h = ranked({
      id: 'convo',
      title: 'why floors on ranking factor score — some heading',
      body: `Q: ${longQuestion}\n\nA: Because zeroing any factor would let it veto the others.`,
    });
    const result = packContext([h], 2000);
    expect(result.nodes[0]!.summary).toBe('Because zeroing any factor would let it veto the others.');
    expect(result.nodes[0]!.summary).not.toContain('floors on ranking factor score');
  });
});

describe('renderContextBlock', () => {
  it('says nothing matched when the pack is empty', () => {
    const result = packContext([], 1000);
    expect(renderContextBlock('foo bar', result)).toContain('No remembered context matched "foo bar"');
  });

  it('renders each node as a dated bullet with its summary', () => {
    const h = ranked({ id: 'a', ts: '2026-08-01T00:00:00Z', title: 'fix: thing', body: 'fix: thing\n\ndetail line' });
    const block = renderContextBlock('thing', packContext([h], 1000));
    expect(block).toContain('2026-08-01');
    expect(block).toContain('fix: thing');
    expect(block).toContain('detail line');
  });
});

describe('retrieval integration (store -> rank -> pack)', () => {
  let dir: string;
  let store: MemoryStore;
  const PROJECT = 'proj-a';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-'));
    store = MemoryStore.open(join(dir, 'memory.db'));

    const node = (overrides: Partial<MemoryNode> & Pick<MemoryNode, 'id'>): MemoryNode => ({
      kind: 'git_commit',
      projectId: PROJECT,
      ts: '2026-08-01T00:00:00Z',
      source: 'git',
      title: 'feat: something',
      body: 'feat: something',
      files: [],
      signal: 0.5,
      meta: {},
      ...overrides,
    });

    store.upsertNodes([
      node({
        id: 'wal',
        signal: 0.9,
        title: 'fix(store): close the WAL handle on Windows',
        body: 'fix(store): close the WAL handle on Windows\n\nSQLite kept the file locked after every write, which blocked cleanup on process exit.',
      }),
      node({
        id: 'chore',
        signal: 0.2,
        title: 'chore: bump sqlite dependency',
        body: 'chore: bump sqlite dependency\n\nRoutine version bump, no behavior change. WAL mode unaffected.',
      }),
    ]);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('ranks the fix above the chore for a shared keyword despite similar relevance', () => {
    const hits = store.search(PROJECT, 'WAL');
    const r = rankHits(hits, { now: NOW });
    expect(r[0]!.id).toBe('wal');
  });

  it('packs less raw text than the full matched bodies', () => {
    const hits = store.search(PROJECT, 'WAL sqlite');
    const r = rankHits(hits, { now: NOW });
    const packed = packContext(r, 2000);

    const rawChars = hits.reduce((n, h) => n + h.body.length, 0);
    const packedChars = packed.nodes.reduce((n, x) => n + x.summary.length + x.title.length, 0);
    expect(packedChars).toBeLessThanOrEqual(rawChars);
  });
});
