import { describe, it, expect } from 'vitest';
import { scoreEnglish } from '../src/ui/board.js';

describe('scoreEnglish (tenhou score string → English)', () => {
  it('renders a ron han/fu value with points', () => {
    expect(scoreEnglish('40符1飜1300点')).toBe('1 han, 40 fu · 1300 pts');
  });
  it('renders a non-dealer tsumo split with a slash', () => {
    expect(scoreEnglish('30符1飜300-500点')).toBe('1 han, 30 fu · 300/500 pts');
  });
  it('renders a dealer tsumo (∀) as "all"', () => {
    expect(scoreEnglish('30符2飜2000点∀')).toBe('2 han, 30 fu · 2000 all');
  });
  it('maps limit hands to English names', () => {
    expect(scoreEnglish('満貫8000点')).toBe('Mangan · 8000 pts');
    expect(scoreEnglish('跳満12000点')).toBe('Haneman · 12000 pts');
    expect(scoreEnglish('倍満16000点')).toBe('Baiman · 16000 pts');
    expect(scoreEnglish('役満32000点')).toBe('Yakuman · 32000 pts');
  });
  it('returns undefined for no score', () => {
    expect(scoreEnglish(undefined)).toBeUndefined();
  });
});
