import { describe, expect, it } from 'vitest';
import { parseClaudeCodeTranscript } from '../src/conversation/claude-code-reader.js';
import { claudeProjectSlug } from '../src/conversation/paths.js';
import { redact } from '../src/conversation/redact.js';
import { collectConversationTurns, scoreConversationTurn, toMemoryNode } from '../src/collectors/conversation.js';
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

describe('scoreConversationTurn', () => {
  const turn = (overrides: Partial<RawConversationTurn>): RawConversationTurn => ({
    naturalKey: 'k',
    userText: 'why is it built this way',
    assistantText: 'a'.repeat(200),
    ts: '2026-08-09T10:00:00.000Z',
    cwd: null,
    source: 'claude-code',
    ...overrides,
  });

  it('scores an explanation-bearing exchange above a trivial one', () => {
    const explained = turn({ assistantText: 'We floor each factor because zeroing one should not veto the others. ' + 'x'.repeat(600) });
    const trivial = turn({ userText: 'ok', assistantText: 'done' });
    expect(scoreConversationTurn(explained)).toBeGreaterThan(scoreConversationTurn(trivial));
  });

  it('stays inside 0.05..1', () => {
    expect(scoreConversationTurn(turn({ assistantText: 'because ' + 'x'.repeat(2000) }))).toBeLessThanOrEqual(1);
    expect(scoreConversationTurn(turn({ userText: 'ok', assistantText: '' }))).toBeGreaterThanOrEqual(0.05);
  });
});

describe('toMemoryNode / collectConversationTurns (conversation)', () => {
  const turn: RawConversationTurn = {
    naturalKey: 'claude-code:u1',
    userText: 'why floors on ranking factor score',
    assistantText: 'Because a zeroed factor in src/retrieval/rank.ts would veto relevance entirely.',
    ts: '2026-08-09T10:00:00.000Z',
    cwd: 'D:\\ai-projects\\NexusMem',
    source: 'claude-code',
  };

  it('is content-addressed via the reader-provided naturalKey', () => {
    const a = toMemoryNode(turn, 'proj1');
    const b = toMemoryNode(turn, 'proj1');
    expect(a.id).toBe(b.id);
  });

  it('tags the node source with conversation:<source>', () => {
    expect(toMemoryNode(turn, 'proj1').source).toBe('conversation:claude-code');
  });

  it('extracts a mentioned file path for cross-referencing', () => {
    const node = toMemoryNode(turn, 'proj1');
    expect(node.files.map((f) => f.path)).toContain('src/retrieval/rank.ts');
  });

  it('redacts secrets before they reach the body', () => {
    const withSecret: RawConversationTurn = { ...turn, assistantText: 'apiKey: "sk-verysecretvalue123"' };
    const node = toMemoryNode(withSecret, 'proj1');
    expect(node.body).not.toContain('sk-verysecretvalue123');
    expect(node.meta.redactedCount).toBeGreaterThan(0);
  });

  it('drops turns with no assistant reply yet', () => {
    const unanswered: RawConversationTurn = { ...turn, assistantText: '' };
    expect(collectConversationTurns([unanswered], 'proj1')).toHaveLength(0);
  });

  it('keeps answered turns', () => {
    expect(collectConversationTurns([turn], 'proj1')).toHaveLength(1);
  });
});
