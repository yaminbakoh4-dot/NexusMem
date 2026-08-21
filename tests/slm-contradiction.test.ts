import { describe, expect, it } from 'vitest';
import {
  buildContradictionPrompt,
  CONTRADICTION_INSTRUCTIONS,
  parseContradictionVerdict,
} from '../src/slm/contradiction.js';

describe('buildContradictionPrompt', () => {
  it('includes both titles and both bodies, older first', () => {
    const prompt = buildContradictionPrompt(
      { title: 'Old decision', body: 'We chose approach A.' },
      { title: 'New decision', body: 'We reversed course to approach B.' },
    );
    expect(prompt.indexOf('Old decision')).toBeLessThan(prompt.indexOf('New decision'));
    expect(prompt).toContain('We chose approach A.');
    expect(prompt).toContain('We reversed course to approach B.');
    expect(prompt.startsWith(CONTRADICTION_INSTRUCTIONS)).toBe(true);
  });

  it('truncates an overlong body instead of sending it in full', () => {
    const long = 'x'.repeat(5000);
    const prompt = buildContradictionPrompt({ title: 'A', body: long }, { title: 'B', body: 'short' });
    expect(prompt.length).toBeLessThan(long.length);
  });
});

describe('parseContradictionVerdict', () => {
  it('parses a well-formed YES with a reason', () => {
    const v = parseContradictionVerdict('VERDICT: YES\nREASON: the plan was reversed');
    expect(v).toEqual({ contradicts: true, reason: 'the plan was reversed' });
  });

  it('parses a well-formed NO', () => {
    const v = parseContradictionVerdict('VERDICT: NO\nREASON: unrelated topics');
    expect(v!.contradicts).toBe(false);
  });

  it('is tolerant of case and surrounding whitespace', () => {
    const v = parseContradictionVerdict('  verdict: yes  \n  reason: fixed the bug  ');
    expect(v).toEqual({ contradicts: true, reason: 'fixed the bug' });
  });

  it('defaults reason to empty string when the REASON line is missing', () => {
    const v = parseContradictionVerdict('VERDICT: YES');
    expect(v).toEqual({ contradicts: true, reason: '' });
  });

  it('returns null for a reply with no VERDICT line -- never guesses YES', () => {
    expect(parseContradictionVerdict('I think these are related but not sure.')).toBeNull();
  });

  it('returns null for an empty reply', () => {
    expect(parseContradictionVerdict('')).toBeNull();
  });

  it('ignores a preamble line before the VERDICT line', () => {
    const v = parseContradictionVerdict('Sure, here is my answer:\nVERDICT: NO\nREASON: different topics');
    expect(v).toEqual({ contradicts: false, reason: 'different topics' });
  });
});
