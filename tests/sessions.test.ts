import { describe, expect, it } from 'vitest';
import { collectSessionSummaries, scoreSession } from '../src/collectors/sessions.js';
import type { RawConversationTurn } from '../src/conversation/types.js';
import { FakeSummarizationProvider } from '../src/slm/provider.js';
import {
  buildSessionPrompt,
  groupTurnsIntoSessions,
  parseSummary,
  selectSettledSessions,
  sessionFallbackTitle,
  SESSION_INSTRUCTIONS,
} from '../src/slm/summarize.js';

const PROJECT = 'proj-a';

function turn(overrides: Partial<RawConversationTurn> & Pick<RawConversationTurn, 'naturalKey'>): RawConversationTurn {
  return {
    userText: 'why does this work?',
    assistantText: 'Because the cursor advances past failures.',
    ts: '2026-08-12T10:00:00.000Z',
    cwd: 'D:\\ai-projects\\NexusMem',
    source: 'claude-code',
    sessionKey: 'claude-code:s1',
    ...overrides,
  };
}

describe('groupTurnsIntoSessions', () => {
  it('groups by session id even when two sessions interleave in time', () => {
    const groups = groupTurnsIntoSessions([
      turn({ naturalKey: 'a', sessionKey: 'claude-code:s1', ts: '2026-08-12T10:00:00.000Z' }),
      turn({ naturalKey: 'b', sessionKey: 'claude-code:s2', ts: '2026-08-12T10:01:00.000Z' }),
      turn({ naturalKey: 'c', sessionKey: 'claude-code:s1', ts: '2026-08-12T10:02:00.000Z' }),
    ]);

    expect(groups).toHaveLength(2);
    // Grouping on a time gap would have split s1 in half around b.
    expect(groups.find((g) => g.sessionKey === 'claude-code:s1')!.turns.map((t) => t.naturalKey)).toEqual(['a', 'c']);
  });

  it('orders a session chronologically regardless of input order', () => {
    const groups = groupTurnsIntoSessions([
      turn({ naturalKey: 'late', ts: '2026-08-12T12:00:00.000Z' }),
      turn({ naturalKey: 'early', ts: '2026-08-12T09:00:00.000Z' }),
    ]);

    expect(groups[0]!.turns.map((t) => t.naturalKey)).toEqual(['early', 'late']);
    expect(groups[0]!.startedAt).toBe('2026-08-12T09:00:00.000Z');
    expect(groups[0]!.endedAt).toBe('2026-08-12T12:00:00.000Z');
  });
});

describe('selectSettledSessions', () => {
  const now = new Date('2026-08-12T12:00:00.000Z');

  it('defers a session that is still being worked in', () => {
    const groups = groupTurnsIntoSessions([turn({ naturalKey: 'a', ts: '2026-08-12T11:50:00.000Z' })]);
    expect(selectSettledSessions(groups, 30, now)).toHaveLength(0);
  });

  it('accepts a session quiet for longer than the settle window', () => {
    const groups = groupTurnsIntoSessions([turn({ naturalKey: 'a', ts: '2026-08-12T11:00:00.000Z' })]);
    expect(selectSettledSessions(groups, 30, now)).toHaveLength(1);
  });

  it('treats an unparseable timestamp as settled rather than dropping the session forever', () => {
    const groups = groupTurnsIntoSessions([turn({ naturalKey: 'a', ts: 'not-a-date' })]);
    expect(selectSettledSessions(groups, 30, now)).toHaveLength(1);
  });
});

describe('buildSessionPrompt', () => {
  it('redacts secrets before the model ever sees them', () => {
    const groups = groupTurnsIntoSessions([
      turn({ naturalKey: 'a', userText: 'here is my token: ghp_abcdefghijklmnopqrstuvwxyz0123' }),
    ]);

    const { prompt } = buildSessionPrompt(groups[0]!);

    expect(prompt).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123');
    // Positive anchor: the surrounding text survives, so this is redaction
    // rather than the turn silently vanishing from the prompt.
    expect(prompt).toContain('here is my token: [redacted]');
  });

  it('hashes the same session to the same value and a changed one differently', () => {
    const a = groupTurnsIntoSessions([turn({ naturalKey: 'a' })]);
    const b = groupTurnsIntoSessions([turn({ naturalKey: 'a' })]);
    const changed = groupTurnsIntoSessions([turn({ naturalKey: 'a', assistantText: 'Something else entirely.' })]);

    expect(buildSessionPrompt(a[0]!).hash).toBe(buildSessionPrompt(b[0]!).hash);
    expect(buildSessionPrompt(changed[0]!).hash).not.toBe(buildSessionPrompt(a[0]!).hash);
  });

  it('keeps every turn when the session fits the budget', () => {
    const groups = groupTurnsIntoSessions([turn({ naturalKey: 'a' }), turn({ naturalKey: 'b', ts: '2026-08-12T10:05:00.000Z' })]);
    expect(buildSessionPrompt(groups[0]!).includedTurns).toBe(2);
  });

  it('drops the lowest-signal turn when over budget, and keeps the rest in order', () => {
    const explanatory = (naturalKey: string, ts: string) =>
      turn({
        naturalKey,
        ts,
        userText: `MARKER-${naturalKey} why was this chosen?`,
        assistantText: `Because ${'the rationale is recorded here. '.repeat(15)}`,
      });
    // Low signal, and sits chronologically *between* the two that matter, at
    // roughly their size. That placement is the point: anything that fills the
    // budget in transcript order takes this turn and then has no room for the
    // last one, so passing here requires selecting by signal.
    const filler = turn({
      naturalKey: 'filler',
      ts: '2026-08-12T10:01:00.000Z',
      userText: 'ok',
      assistantText: `MARKER-filler ${'x'.repeat(470)}`,
    });

    const groups = groupTurnsIntoSessions([
      explanatory('first', '2026-08-12T10:00:00.000Z'),
      filler,
      explanatory('last', '2026-08-12T10:02:00.000Z'),
    ]);

    const full = buildSessionPrompt(groups[0]!);
    expect(full.includedTurns).toBe(3);

    // Room for any two of the three, never all three.
    const budget = SESSION_INSTRUCTIONS.length + 1400;
    const trimmed = buildSessionPrompt(groups[0]!, budget);

    expect(trimmed.includedTurns).toBe(2);
    expect(trimmed.prompt).not.toContain('MARKER-filler');
    expect(trimmed.prompt.indexOf('MARKER-first')).toBeLessThan(trimmed.prompt.indexOf('MARKER-last'));
  });
});

describe('parseSummary', () => {
  const FALLBACK = 'add a batch embedding pass';

  it('splits a well-formed reply into title and body', () => {
    const parsed = parseSummary('TITLE: Fixed the embedding cap\n- Chose batching because latency dominated.', FALLBACK);
    expect(parsed).toEqual({
      title: 'Fixed the embedding cap',
      body: '- Chose batching because latency dominated.',
    });
  });

  it('still produces a body when the model emitted only a title', () => {
    const parsed = parseSummary('TITLE: Fixed the embedding cap', FALLBACK);
    expect(parsed).toEqual({ title: 'Fixed the embedding cap', body: 'Fixed the embedding cap' });
  });

  it('returns null for an empty or whitespace-only reply', () => {
    expect(parseSummary('', FALLBACK)).toBeNull();
    expect(parseSummary('   \n  \n', FALLBACK)).toBeNull();
  });

  it('redacts a secret the model echoed back into its summary', () => {
    const parsed = parseSummary(
      'TITLE: Debugged auth\n- The user pasted ghp_abcdefghijklmnopqrstuvwxyz0123 into the config.',
      FALLBACK,
    );
    expect(parsed!.body).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123');
    expect(parsed!.body).toContain('[redacted]');
  });

  // The three shapes a 3B model actually produced over 14 real sessions.
  // Each one previously became the stored title verbatim.
  it('rejects a conversational preamble that arrived instead of a title', () => {
    const parsed = parseSummary('ดีใจที่ได้ช่วยตรวจสอบครบทั้ง 4 ข้อแล้วครับ สรุปดังนี้:\n- Did a thing.', FALLBACK);

    expect(parsed!.title).toBe(FALLBACK);
    // The prose is still content; only its promotion to a title was wrong.
    expect(parsed!.body).toContain('ดีใจที่ได้ช่วย');
  });

  it('rejects a generic title that names no particular session', () => {
    for (const generic of ['Summary of the Session', 'Project Update', 'session summary', 'Recap']) {
      expect(parseSummary(`TITLE: ${generic}\n- Did a thing.`, FALLBACK)!.title).toBe(FALLBACK);
    }
  });

  it('strips markdown decoration rather than storing it', () => {
    const parsed = parseSummary('TITLE: **Chose to sync the MCP index:**\n- Did a thing.', FALLBACK);
    expect(parsed!.title).toBe('Chose to sync the MCP index');
  });

  it('keeps a specific title that merely resembles a generic one', () => {
    // "Summary" as a prefix is the problem, not the word appearing at all.
    const parsed = parseSummary('TITLE: Summarized sessions with a local model\n- Did a thing.', FALLBACK);
    expect(parsed!.title).toBe('Summarized sessions with a local model');
  });

  // Two titles a 3B model actually produced live, verified against the real DB
  // to confirm they are the model's own TITLE: line, not the human's opening
  // question leaking through sessionFallbackTitle: neither string appears
  // anywhere in the project's conversation_turn transcripts. The model wrote a
  // role/persona framing instead of naming what happened in the session.
  it('rejects a role-preamble title the model wrote instead of a summary (Thai)', () => {
    const parsed = parseSummary('TITLE: บทบาท: Lead Systems Engineer ประจำโปรเจกต์ NexusMem\n- Did a thing.', FALLBACK);
    expect(parsed!.title).toBe(FALLBACK);
  });

  it('rejects a "you are" role-preamble title the model wrote instead of a summary (Thai)', () => {
    const parsed = parseSummary(
      'TITLE: คุณกำลังทำหน้าที่เป็นผู้ทดสอบ NexusMem ซึ่งเป็นระบบ Persistent Development Memory ที่เชื่อมต่อกับ coding agent ผ่าน MCP\n- Did a thing.',
      FALLBACK,
    );
    expect(parsed!.title).toBe(FALLBACK);
  });

  it('rejects the same role-preamble shapes in English, since the model does not reliably obey "answer in English" either', () => {
    expect(parseSummary('TITLE: Role: Lead Backend Engineer for the API team\n- Did a thing.', FALLBACK)!.title).toBe(FALLBACK);
    expect(parseSummary('TITLE: You are acting as a senior reviewer for this repo\n- Did a thing.', FALLBACK)!.title).toBe(
      FALLBACK,
    );
  });

  it('keeps a specific Thai title that merely starts with the same syllables as a role pronoun', () => {
    // "คุณภาพ" (quality) starts with "คุณ" (you) but is a different word entirely --
    // a real title from this project's own history, kept as an anti-false-positive anchor.
    const parsed = parseSummary('TITLE: เอาภาษาไทยออกจาก repo ให้หมด\n- Did a thing.', FALLBACK);
    expect(parsed!.title).toBe('เอาภาษาไทยออกจาก repo ให้หมด');

    const quality = parseSummary('TITLE: คุณภาพโค้ดหลังรีแฟคเตอร์ rank.ts\n- Did a thing.', FALLBACK);
    expect(quality!.title).toBe('คุณภาพโค้ดหลังรีแฟคเตอร์ rank.ts');
  });
});

describe('sessionFallbackTitle', () => {
  it('uses the first line of the question that opened the session', () => {
    const groups = groupTurnsIntoSessions([
      turn({ naturalKey: 'a', ts: '2026-08-12T10:00:00.000Z', userText: 'fix the ranking\nand also the docs' }),
      turn({ naturalKey: 'b', ts: '2026-08-12T11:00:00.000Z', userText: 'thanks' }),
    ]);
    expect(sessionFallbackTitle(groups[0]!)).toBe('fix the ranking');
  });

  it('redacts, so a secret in the opening message cannot become a title', () => {
    const groups = groupTurnsIntoSessions([
      turn({ naturalKey: 'a', userText: 'my token is ghp_abcdefghijklmnopqrstuvwxyz0123' }),
    ]);
    expect(sessionFallbackTitle(groups[0]!)).toBe('my token is [redacted]');
  });
});

describe('collectSessionSummaries', () => {
  const now = new Date('2026-08-12T18:00:00.000Z');
  const settledTurn = (naturalKey: string, overrides: Partial<RawConversationTurn> = {}) =>
    turn({ naturalKey, ts: '2026-08-12T10:00:00.000Z', ...overrides });

  it('produces one node per settled session', async () => {
    const provider = new FakeSummarizationProvider(() => 'TITLE: Session one\n- Did a thing because reasons.');
    const result = await collectSessionSummaries(
      [settledTurn('a', { sessionKey: 'claude-code:s1' }), settledTurn('b', { sessionKey: 'claude-code:s2' })],
      PROJECT,
      provider,
      { now },
    );

    expect(result.nodes).toHaveLength(2);
    expect(result.nodes.map((n) => n.kind)).toEqual(['session_summary', 'session_summary']);
    expect(result.nodes[0]!.source).toBe('session:claude-code');
  });

  it('does not call the model for a session whose content is unchanged', async () => {
    const provider = new FakeSummarizationProvider();
    const turns = [settledTurn('a')];

    const first = await collectSessionSummaries(turns, PROJECT, provider, { now });
    const storedHash = first.nodes[0]!.meta.contentHash as string;

    const second = await collectSessionSummaries(turns, PROJECT, provider, {
      now,
      knownHash: (key) => (key === 'claude-code:s1' ? storedHash : null),
    });

    expect(second.cached).toBe(1);
    expect(second.nodes).toHaveLength(0);
    // The real cost this guards is the model call, so count those, not nodes.
    expect(provider.prompts).toHaveLength(1);
  });

  it('re-summarizes when the session has grown since the stored hash', async () => {
    const provider = new FakeSummarizationProvider();
    const first = await collectSessionSummaries([settledTurn('a')], PROJECT, provider, { now });
    const storedHash = first.nodes[0]!.meta.contentHash as string;

    const second = await collectSessionSummaries([settledTurn('a'), settledTurn('b')], PROJECT, provider, {
      now,
      knownHash: () => storedHash,
    });

    expect(second.cached).toBe(0);
    expect(second.nodes).toHaveLength(1);
    expect(second.nodes[0]!.meta.turnCount).toBe(2);
  });

  it('keeps the node id stable across runs so a re-summary replaces rather than duplicates', async () => {
    const provider = new FakeSummarizationProvider();
    const a = await collectSessionSummaries([settledTurn('a')], PROJECT, provider, { now });
    const b = await collectSessionSummaries([settledTurn('a'), settledTurn('b')], PROJECT, provider, { now });

    expect(a.nodes[0]!.id).toBe(b.nodes[0]!.id);
  });

  it('caps sessions per run and takes the most recent first', async () => {
    const provider = new FakeSummarizationProvider();
    const turns = [
      settledTurn('old', { sessionKey: 'claude-code:old', ts: '2026-08-10T10:00:00.000Z' }),
      settledTurn('new', { sessionKey: 'claude-code:new', ts: '2026-08-12T10:00:00.000Z' }),
    ];

    const result = await collectSessionSummaries(turns, PROJECT, provider, { now, maxSessions: 1 });

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]!.meta.sessionKey).toBe('claude-code:new');
    // Ready but queued, which is not the same as "still being worked in".
    expect(result.deferred).toBe(1);
    expect(result.unsettled).toBe(0);
  });

  it('does not count a cached session as deferred', async () => {
    const provider = new FakeSummarizationProvider();
    // Two sessions, both already summarized, and a cap of one. Counting
    // deferred work from the eligible list rather than the outstanding list
    // would claim one is queued when there is nothing left to do.
    const turns = [
      settledTurn('a', { sessionKey: 'claude-code:s1', userText: 'first question?' }),
      settledTurn('b', { sessionKey: 'claude-code:s2', userText: 'second question?' }),
    ];

    const first = await collectSessionSummaries(turns, PROJECT, provider, { now, maxSessions: 2 });
    const hashes = new Map(first.nodes.map((n) => [n.meta.sessionKey as string, n.meta.contentHash as string]));
    expect(hashes.size).toBe(2);

    const second = await collectSessionSummaries(turns, PROJECT, provider, {
      now,
      maxSessions: 1,
      knownHash: (key) => hashes.get(key) ?? null,
    });

    expect(second.cached).toBe(2);
    expect(second.deferred).toBe(0);
  });

  it('titles a node from the opening question when the model ignores the format', async () => {
    const rambling = new FakeSummarizationProvider(() => 'Sure! Here is what I found in this session:\n- Did a thing.');
    const result = await collectSessionSummaries(
      [settledTurn('a', { userText: 'remove all the Thai text from the repo' })],
      PROJECT,
      rambling,
      { now },
    );

    expect(result.nodes[0]!.title).toBe('remove all the Thai text from the repo');
  });

  it('reports an unavailable model without throwing, and stores nothing', async () => {
    const dead = new FakeSummarizationProvider(() => null);
    const result = await collectSessionSummaries([settledTurn('a')], PROJECT, dead, { now });

    expect(result.providerUnavailable).toBe(true);
    expect(result.failed).toBe(1);
    expect(result.nodes).toHaveLength(0);
  });

  it('counts sessions that are still active instead of summarizing them', async () => {
    const provider = new FakeSummarizationProvider();
    const result = await collectSessionSummaries(
      [turn({ naturalKey: 'live', ts: '2026-08-12T17:55:00.000Z' })],
      PROJECT,
      provider,
      { now },
    );

    expect(result.unsettled).toBe(1);
    expect(provider.prompts).toHaveLength(0);
  });

  it('dates the node by when the session ended, and links the files it touched', async () => {
    const provider = new FakeSummarizationProvider(() => 'TITLE: Ranking work\n- Adjusted the exponents.');
    const result = await collectSessionSummaries(
      [
        settledTurn('a', { ts: '2026-08-12T10:00:00.000Z', userText: 'look at src/retrieval/rank.ts' }),
        settledTurn('b', { ts: '2026-08-12T11:30:00.000Z' }),
      ],
      PROJECT,
      provider,
      { now },
    );

    const node = result.nodes[0]!;
    expect(node.ts).toBe('2026-08-12T11:30:00.000Z');
    // Drawn from the transcript, not from the summary -- the model mentioned no paths.
    expect(node.files.map((f) => f.path)).toContain('src/retrieval/rank.ts');
    expect(node.body).toContain('2 exchange(s)');
  });
});

describe('scoreSession', () => {
  it('ranks a longer session above a short one, within a bounded range', () => {
    expect(scoreSession(30)).toBeGreaterThan(scoreSession(3));
    expect(scoreSession(1)).toBeGreaterThanOrEqual(0.6);
    expect(scoreSession(10_000)).toBeLessThanOrEqual(0.85);
  });
});
