import { describe, expect, it } from 'vitest';
import { parseClaudeCodeTranscript } from '../src/conversation/claude-code-reader.js';
import { chunkAssistantText } from '../src/conversation/chunk.js';
import { claudeProjectSlug } from '../src/conversation/paths.js';
import { redact } from '../src/conversation/redact.js';
import { collectConversationTurns, scoreConversationTurn, toMemoryNodes } from '../src/collectors/conversation.js';
import type { RawConversationTurn } from '../src/conversation/types.js';

/** Build one synthetic transcript line, matching the real on-disk shape. */
function line(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

function userLine(uuid: string, text: string, extra: Record<string, unknown> = {}): string {
  return line({
    type: 'user',
    uuid,
    timestamp: '2026-08-09T10:00:00.000Z',
    cwd: 'D:\\ai-projects\\NexusMem',
    message: { role: 'user', content: text },
    ...extra,
  });
}

function toolResultUserLine(uuid: string): string {
  return line({
    type: 'user',
    uuid,
    timestamp: '2026-08-09T10:00:05.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', content: 'file contents...' }] },
  });
}

function assistantTextLine(text: string, extra: Record<string, unknown> = {}): string {
  return line({
    type: 'assistant',
    uuid: `a-${Math.random()}`,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    ...extra,
  });
}

function assistantThinkingLine(text: string): string {
  return line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: text }] } });
}

function assistantToolUseLine(): string {
  return line({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] },
  });
}

describe('parseClaudeCodeTranscript', () => {
  it('pairs a user message with the assistant text that follows', () => {
    const raw = [userLine('u1', 'why floors on ranking factor score'), assistantTextLine('Because zeroing any factor would let it veto the others.')].join('\n');

    const turns = parseClaudeCodeTranscript(raw);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.userText).toBe('why floors on ranking factor score');
    expect(turns[0]!.assistantText).toContain('veto the others');
    expect(turns[0]!.naturalKey).toBe('claude-code:u1');
  });

  it('concatenates assistant text split across multiple records into one exchange', () => {
    const raw = [userLine('u1', 'explain the design'), assistantTextLine('Part one.'), assistantToolUseLine(), assistantTextLine('Part two.')].join('\n');

    const turns = parseClaudeCodeTranscript(raw);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.assistantText).toBe('Part one.\n\nPart two.');
  });

  it('excludes thinking and tool_use blocks from the indexed text', () => {
    const raw = [userLine('u1', 'q'), assistantThinkingLine('secret deliberation'), assistantToolUseLine(), assistantTextLine('the real answer')].join('\n');

    const turns = parseClaudeCodeTranscript(raw);
    expect(turns[0]!.assistantText).toBe('the real answer');
    expect(turns[0]!.assistantText).not.toContain('secret deliberation');
  });

  it('treats a tool-result user record as plumbing, not a human message', () => {
    const raw = [userLine('u1', 'real question'), assistantTextLine('answer'), toolResultUserLine('u2'), assistantTextLine('more tool output narration')].join('\n');

    const turns = parseClaudeCodeTranscript(raw);
    // The tool-result record does not start a new exchange; its surrounding
    // assistant text is folded into the still-open first exchange.
    expect(turns).toHaveLength(1);
    expect(turns[0]!.userText).toBe('real question');
    expect(turns[0]!.assistantText).toContain('more tool output narration');
  });

  it('splits into multiple exchanges at each real human message', () => {
    const raw = [userLine('u1', 'first question'), assistantTextLine('first answer'), userLine('u2', 'second question'), assistantTextLine('second answer')].join('\n');

    const turns = parseClaudeCodeTranscript(raw);
    expect(turns.map((t) => t.userText)).toEqual(['first question', 'second question']);
    expect(turns.map((t) => t.assistantText)).toEqual(['first answer', 'second answer']);
  });

  it('excludes sidechain records from the primary conversation', () => {
    const raw = [userLine('u1', 'main question'), line({ type: 'user', uuid: 'sub1', isSidechain: true, message: { role: 'user', content: 'sub-agent prompt' } }), assistantTextLine('main answer')].join('\n');

    const turns = parseClaudeCodeTranscript(raw);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.userText).toBe('main question');
  });

  it('skips malformed lines without throwing', () => {
    const raw = ['not json', '', userLine('u1', 'q'), '{"broken":', assistantTextLine('a')].join('\n');
    expect(() => parseClaudeCodeTranscript(raw)).not.toThrow();
    expect(parseClaudeCodeTranscript(raw)).toHaveLength(1);
  });

  it('produces no turn for a trailing human message with no reply yet', () => {
    const raw = [userLine('u1', 'answered'), assistantTextLine('yes'), userLine('u2', 'still waiting')].join('\n');
    const turns = parseClaudeCodeTranscript(raw);
    expect(turns).toHaveLength(2);
    expect(turns[1]!.assistantText).toBe('');
  });

  it('carries cwd through from the user record', () => {
    const raw = userLine('u1', 'q') + '\n' + assistantTextLine('a');
    expect(parseClaudeCodeTranscript(raw)[0]!.cwd).toBe('D:\\ai-projects\\NexusMem');
  });
});

describe('claudeProjectSlug', () => {
  it('matches the real observed on-disk slug for a Windows path', () => {
    expect(claudeProjectSlug('D:\\ai-projects\\NexusMem')).toBe('D--ai-projects-NexusMem');
  });

  it('preserves hyphens already in folder names', () => {
    expect(claudeProjectSlug('D:\\SaaS-Projects\\medical-SaaS')).toBe('D--SaaS-Projects-medical-SaaS');
  });
});

describe('redact', () => {
  it('redacts a private key block', () => {
    const text = 'here is my key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIExyz\n-----END RSA PRIVATE KEY-----\nthanks';
    const result = redact(text);
    expect(result.text).not.toContain('MIIExyz');
    expect(result.redactedCount).toBeGreaterThan(0);
  });

  it('redacts a github token', () => {
    const result = redact('use ghp_abcdefghijklmnopqrstuvwxyz012345 to auth');
    expect(result.text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz012345');
  });

  /**
   * Every rule except `key-value-secret` has no capture group, so
   * `String.replace`'s callback receives `(match, offset, string)` rather than
   * `(match, group)`. A non-zero offset is truthy, which is enough to take the
   * "keep the key name" branch and splice the match position into the corpus.
   *
   * The assertions below are positive on purpose: the existing tests only
   * assert the secret is *absent*, which stays true no matter what junk
   * replaces it, and is why this survived a green suite.
   */
  it('replaces a groupless match with exactly [redacted], at any offset', () => {
    expect(redact('AKIAIOSFODNN7EXAMPLE').text).toBe('[redacted]');
    expect(redact('use AKIAIOSFODNN7EXAMPLE please').text).toBe('use [redacted] please');
    expect(redact('creds are ghp_abcdefghijklmnopqrstuvwxyz0123456789').text).toBe('creds are [redacted]');
  });

  it('never leaks a match offset into the redacted text', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const result = redact(`here is my token: ${jwt}`);
    expect(result.text).toBe('here is my token: [redacted]');
    expect(result.text).not.toMatch(/\d+: \[redacted\]/);
  });

  it('still keeps the key name for the one rule that really has a capture group', () => {
    expect(redact('the apiKey = "abcdefgh12345678" ok').text).toBe('the apiKey: [redacted] ok');
  });

  it('redacts key/value style secrets while keeping the key name legible', () => {
    const result = redact('apiKey: "sk-1234567890abcdef"');
    expect(result.text).toContain('apiKey: [redacted]');
    expect(result.text).not.toContain('sk-1234567890abcdef');
  });

  it('leaves ordinary text untouched', () => {
    const text = 'we chose BM25 because developer queries are keyword-heavy';
    expect(redact(text)).toEqual({ text, redactedCount: 0 });
  });
});

describe('chunkAssistantText', () => {
  it('keeps a short reply as one chunk', () => {
    const chunks = chunkAssistantText('Because zeroing one factor would let it veto the others.', 900);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.heading).toBeNull();
  });

  it('splits at bold-lead paragraphs -- this project\'s actual chat-writing style', () => {
    const text = [
      '**First point.** Some explanation of the first point that goes on for a while.',
      '**Second point.** A completely different explanation about something else entirely.',
    ].join('\n\n');

    const chunks = chunkAssistantText(text, 900);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.heading).toBe('First point.');
    expect(chunks[1]!.heading).toBe('Second point.');
    expect(chunks[1]!.text).not.toContain('First point');
  });

  it('splits at literal markdown headings', () => {
    const text = '## Section A\n\nContent A.\n\n## Section B\n\nContent B.';
    const chunks = chunkAssistantText(text, 900);
    expect(chunks.map((c) => c.heading)).toEqual(['Section A', 'Section B']);
  });

  it('falls back to size-based splitting when there is no heading/bold structure at all', () => {
    const paragraphs = Array.from({ length: 5 }, (_, i) => `Plain paragraph number ${i} with some filler text in it.`);
    const chunks = chunkAssistantText(paragraphs.join('\n\n'), 120);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.heading === null)).toBe(true);
  });

  it('hard-truncates a single paragraph that alone exceeds maxChars', () => {
    const chunks = chunkAssistantText('x'.repeat(2000), 500);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text.length).toBeLessThanOrEqual(500);
  });

  it('returns nothing for empty input', () => {
    expect(chunkAssistantText('', 900)).toEqual([]);
  });

  it('reproduces the acceptance-test failure mode and confirms the fix: a specific point survives being embedded in a long multi-topic reply', () => {
    const longReply = [
      '**Content-addressed ids.** Running sync twice can never produce duplicates.',
      '**Stable project identity.** Two clones of the same repo share one memory namespace.',
      '**Score = relevance x signal x recency, each floored, never zeroed.** Each factor lives in [floor, 1], not [0, 1] -- multiplying three [0,1] terms lets any single dimension crush the other two to zero, so floors keep the combination a reordering instead of a gate.',
      '**Keyword search before vector search.** Developer queries are keyword-heavy.',
      '**Streaming collectors.** git log is parsed incrementally from a stream.',
    ].join('\n\n');

    // The old, unchunked behavior: one 4000-char-capped node for the whole
    // thing. Confirm the specific point is only a small fraction of it.
    expect(longReply.length).toBeGreaterThan(400);

    const chunks = chunkAssistantText(longReply, 900);
    const floorsChunk = chunks.find((c) => c.heading?.startsWith('Score = relevance'));
    expect(floorsChunk).toBeDefined();
    expect(floorsChunk!.text).toContain('crush the other two to zero');
    // It is its own chunk, not diluted by the four unrelated points around it.
    expect(floorsChunk!.text).not.toContain('Content-addressed');
    expect(floorsChunk!.text).not.toContain('Streaming collectors');
  });
});

describe('scoreConversationTurn', () => {
  it('scores an explanation-bearing reply above a trivial one', () => {
    const explained = scoreConversationTurn(
      'why is it built this way',
      'We floor each factor because zeroing one should not veto the others. ' + 'x'.repeat(600),
    );
    const trivial = scoreConversationTurn('ok', 'done');
    expect(explained).toBeGreaterThan(trivial);
  });

  it('stays inside 0.05..1', () => {
    expect(scoreConversationTurn('why', 'because ' + 'x'.repeat(2000))).toBeLessThanOrEqual(1);
    expect(scoreConversationTurn('ok', '')).toBeGreaterThanOrEqual(0.05);
  });
});

describe('toMemoryNodes / collectConversationTurns (conversation)', () => {
  const turn: RawConversationTurn = {
    naturalKey: 'claude-code:u1',
    userText: 'why floors on ranking factor score',
    assistantText: 'Because a zeroed factor in src/retrieval/rank.ts would veto relevance entirely.',
    ts: '2026-08-09T10:00:00.000Z',
    cwd: 'D:\\ai-projects\\NexusMem',
    source: 'claude-code',
  };

  it('is content-addressed via the reader-provided naturalKey plus a chunk index', () => {
    const a = toMemoryNodes(turn, 'proj1');
    const b = toMemoryNodes(turn, 'proj1');
    expect(a[0]!.id).toBe(b[0]!.id);
  });

  it('tags the node source with conversation:<source>', () => {
    expect(toMemoryNodes(turn, 'proj1')[0]!.source).toBe('conversation:claude-code');
  });

  it('extracts a mentioned file path for cross-referencing', () => {
    const node = toMemoryNodes(turn, 'proj1')[0]!;
    expect(node.files.map((f) => f.path)).toContain('src/retrieval/rank.ts');
  });

  it('redacts secrets before they reach the body', () => {
    const withSecret: RawConversationTurn = { ...turn, assistantText: 'apiKey: "sk-verysecretvalue123"' };
    const node = toMemoryNodes(withSecret, 'proj1')[0]!;
    expect(node.body).not.toContain('sk-verysecretvalue123');
    expect(node.meta.redactedCount).toBeGreaterThan(0);
  });

  it('drops turns with no assistant reply yet', () => {
    const unanswered: RawConversationTurn = { ...turn, assistantText: '' };
    expect(collectConversationTurns([unanswered], 'proj1')).toHaveLength(0);
  });

  it('keeps answered turns as exactly one node when short', () => {
    expect(collectConversationTurns([turn], 'proj1')).toHaveLength(1);
  });

  it('produces multiple nodes, distinct ids and per-chunk titles for a long multi-point reply', () => {
    const longTurn: RawConversationTurn = {
      ...turn,
      assistantText: [
        '**First point.** ' + 'Explanation of the first point. '.repeat(20),
        '**Second point.** ' + 'A different explanation entirely. '.repeat(20),
      ].join('\n\n'),
    };

    const nodes = toMemoryNodes(longTurn, 'proj1', { maxChunkChars: 400 });
    expect(nodes.length).toBeGreaterThan(1);

    const ids = nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length); // all distinct

    expect(nodes[0]!.title).toContain('First point');
    expect(nodes[1]!.title).toContain('Second point');
    expect(nodes.every((n) => n.meta.chunkCount === nodes.length)).toBe(true);
  });

  it('keeps titles distinct even when the original question alone exceeds the title length cap', () => {
    const longQuestionTurn: RawConversationTurn = {
      ...turn,
      userText: 'x'.repeat(250), // longer than MAX_TITLE_CHARS on its own, no newline to shorten "first line"
      assistantText: [
        '**First point.** ' + 'a'.repeat(500),
        '**Second point.** ' + 'b'.repeat(500),
        '**Third point.** ' + 'c'.repeat(500),
      ].join('\n\n'),
    };

    const nodes = toMemoryNodes(longQuestionTurn, 'proj1', { maxChunkChars: 300 });
    expect(nodes.length).toBeGreaterThan(1);

    const titles = nodes.map((n) => n.title);
    expect(new Set(titles).size).toBe(titles.length); // every title distinct
    for (const title of titles) expect(title).toMatch(/—|\(part \d+\/\d+\)/); // suffix actually survived
  });

  it('every chunk repeats the original question, so each node is self-contained', () => {
    const longTurn: RawConversationTurn = {
      ...turn,
      assistantText: [
        '**First point.** ' + 'x'.repeat(500),
        '**Second point.** ' + 'y'.repeat(500),
      ].join('\n\n'),
    };
    const nodes = toMemoryNodes(longTurn, 'proj1', { maxChunkChars: 300 });
    expect(nodes.length).toBeGreaterThan(1);
    for (const node of nodes) expect(node.body).toContain('why floors on ranking factor score');
  });
});
