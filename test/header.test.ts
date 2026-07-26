import { describe, it, expect } from 'vitest';
import { spliceRoundHeader } from '../src/stream/header.js';
import { parseStream } from '../src/stream/parse.js';

describe('spliceRoundHeader', () => {
  const blank = { dora: '', haipai: ['', '', '', ''], names: ['', '', '', ''] };

  it('fills haipai placeholders while keeping the round token and plays', () => {
    const out = spliceRoundHeader('e1 ? ? ? ? 1z 9p 8p ryuukyoku', 0, {
      ...blank, haipai: ['123456789m1234z1z', '123456789p1234z', '123456789s1234z', '123456789p1234z'],
    });
    expect(out).toBe('e1 123456789m1234z1z 123456789p1234z 123456789s1234z 123456789p1234z 1z 9p 8p ryuukyoku');
    // and it parses back to a full haipai
    const k = parseStream(out).game.kyokus[0];
    expect(k.players[0].haipai.length + (k.players[0].turns[0]?.draw !== undefined ? 1 : 0)).toBe(14);
  });

  it('adds a dora indicator token (di form) and replaces an existing one', () => {
    const a = spliceRoundHeader('e1 ? ? ? ? 1z', 0, { ...blank, dora: '0p' });
    expect(a).toBe('e1 di0p ? ? ? ? 1z');
    const b = spliceRoundHeader('e1 d5m ? ? ? ? 1z', 0, { ...blank, dora: '6p' });
    expect(b).toBe('e1 di6p ? ? ? ? 1z');
    expect(parseStream(a).game.kyokus[0].doraIndicators).toEqual([52]); // red-five 5p indicator
  });

  it('preserves player names via a name: prefix', () => {
    const out = spliceRoundHeader('e1 Okada:123m ? ? ? 1z', 0, {
      ...blank, haipai: ['123456789m1234z1z', '', '', ''], names: ['Okada', '', '', ''],
    });
    expect(out).toBe('e1 Okada:123456789m1234z1z ? ? ? 1z');
  });

  it('edits the requested kyoku only, leaving others intact', () => {
    const text = 'e1 ? ? ? ? 1z ryuukyoku e2 ? ? ? ? 2z ryuukyoku';
    const out = spliceRoundHeader(text, 1, { ...blank, dora: '3s' });
    expect(out).toBe('e1 ? ? ? ? 1z ryuukyoku e2 di3s ? ? ? ? 2z ryuukyoku');
  });

  it('returns text unchanged when the round token is absent', () => {
    expect(spliceRoundHeader('', 0, { ...blank, dora: '6p' })).toBe('');
  });
});
