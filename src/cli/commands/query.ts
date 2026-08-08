import pc from 'picocolors';
import { approxTokens } from '../../core/text.js';
import { packContext, renderContextBlock } from '../../retrieval/pack.js';
import { rankHits } from '../../retrieval/rank.js';
import { MemoryStore } from '../../store/store.js';
import { loadContext } from '../context.js';

export interface QueryOptions {
  cwd: string;
  query: string;
  /** Token budget for the packed context that gets printed to stdout. */
  budget: number;
  /** How many FTS candidates to rank/pack from, before the budget is applied. */
  candidates: number;
  halfLifeDays?: number;
  json: boolean;
}

export async function runQuery(opts: QueryOptions): Promise<number> {
  const { ws, projectId } = await loadContext(opts.cwd);
  const store = MemoryStore.open(ws.dbPath);

  try {
    const hits = store.search(projectId, opts.query, opts.candidates);
    const ranked = rankHits(hits, { halfLifeDays: opts.halfLifeDays });
    const packed = packContext(ranked, opts.budget);

    // What it would have cost to hand the agent every match, unranked and
    // unpacked -- the number the packing step is actually saving against.
    //
    // Can go negative: for a handful of small matches, fixed per-node
    // formatting overhead can outweigh what little there was to trim. Real
    // savings come from two places -- dropping low-score matches entirely
    // once candidates exceed the budget, and truncating large bodies -- and
    // neither has much to work with on a tiny, already-terse result set.
    const rawTokens = hits.reduce((n, h) => n + approxTokens(h.body), 0);
    const savedPct = rawTokens > 0 ? 1 - packed.tokensUsed / rawTokens : 0;

    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            query: opts.query,
            matched: hits.length,
            packed: packed.nodes,
            tokensUsed: packed.tokensUsed,
            tokensBudget: packed.tokensBudget,
            droppedForBudget: packed.droppedForBudget,
            rawTokensIfUnpacked: rawTokens,
            estimatedSavingsPct: Number((savedPct * 100).toFixed(1)),
          },
          null,
          2,
        )}\n`,
      );
      return 0;
    }

    if (hits.length === 0) {
      process.stderr.write(`${pc.yellow('no matches')} for "${opts.query}"\n`);
      return 0;
    }

    process.stderr.write(
      [
        `${pc.dim('matched')} ${hits.length} node(s), packed ${pc.bold(String(packed.nodes.length))} into budget`,
        `${pc.dim('tokens ')} ${packed.tokensUsed}/${packed.tokensBudget}` +
          (packed.droppedForBudget ? pc.dim(`  (${packed.droppedForBudget} dropped for budget)`) : ''),
        rawTokens > 0
          ? `${pc.dim('vs raw ')} ${rawTokens} tokens if all matches were sent unpacked  ${savedPct >= 0 ? pc.green(`(${(savedPct * 100).toFixed(0)}% saved)`) : pc.yellow(`(${(-savedPct * 100).toFixed(0)}% more -- overhead dominates on small result sets)`)}`
          : '',
        '',
      ]
        .filter(Boolean)
        .join('\n'),
    );

    process.stdout.write(`${renderContextBlock(opts.query, packed)}\n`);
    return 0;
  } finally {
    store.close();
  }
}
