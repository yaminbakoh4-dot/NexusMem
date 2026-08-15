import { describe, expect, it } from 'vitest';
import { shouldCheckFailure, shouldNotify, truncateForNotification } from '../src/failureDetection.js';

describe('shouldCheckFailure', () => {
  const base = { exitCode: 1, commandLine: 'npm whoami', confidence: 2 };

  it('checks a real, high-confidence failure', () => {
    expect(shouldCheckFailure(base)).toBe(true);
  });

  it('skips a successful command (exitCode 0)', () => {
    expect(shouldCheckFailure({ ...base, exitCode: 0 })).toBe(false);
  });

  it('skips an ambiguous exit code -- Ctrl+C, a sub-shell, or an unreported exit are all indistinguishable here', () => {
    expect(shouldCheckFailure({ ...base, exitCode: undefined })).toBe(false);
  });

  it('skips low-confidence command-line text, which can be garbled terminal-buffer heuristics', () => {
    expect(shouldCheckFailure({ ...base, confidence: 0 })).toBe(false);
  });

  it('accepts medium confidence, not just high', () => {
    expect(shouldCheckFailure({ ...base, confidence: 1 })).toBe(true);
  });

  it('skips a blank command line', () => {
    expect(shouldCheckFailure({ ...base, commandLine: '   ' })).toBe(false);
  });
});

describe('shouldNotify', () => {
  it('notifies when the search actually matched something', () => {
    expect(shouldNotify({ matched: 1, text: 'you hit this before' })).toBe(true);
  });

  it('stays silent when nothing matched', () => {
    expect(shouldNotify({ matched: 0, text: '' })).toBe(false);
  });

  it('stays silent when matched is positive but the packed text is empty', () => {
    // Discriminating: matched > 0 alone is not sufficient -- a stale/blank text field would be a
    // notification with nothing to show for "Show details".
    expect(shouldNotify({ matched: 3, text: '   ' })).toBe(false);
  });
});

describe('truncateForNotification', () => {
  it('leaves a short command line untouched', () => {
    expect(truncateForNotification('npm whoami')).toBe('npm whoami');
  });

  it('trims surrounding whitespace', () => {
    expect(truncateForNotification('  npm whoami  ')).toBe('npm whoami');
  });

  it('truncates a long command line with an ellipsis, capped at 80 characters', () => {
    const long = 'a'.repeat(200);
    const result = truncateForNotification(long);
    expect(result.length).toBe(80);
    expect(result.endsWith('…')).toBe(true);
  });
});
