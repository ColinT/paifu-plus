import { describe, it, expect } from 'vitest';
import { parseStream } from '../src/stream/parse.js';
import { gameToStream } from '../src/stream/serialize.js';
import type { Game } from '../src/core/model.js';

/** Compare per-player haipai + discard sequences (the parts the DSL fully
 *  round-trips). Result attribution (ron winner) is a known DSL limitation. */
function rivers(g: Game, ky = 0) {
  return g.kyokus[ky].players.map((p) => ({
    haipai: [...p.haipai].sort((a, b) => a - b),
    discards: p.turns.filter((t) => t.discard !== undefined).map((t) => t.discard),
  }));
}

describe('gameToStream (game → transcription)', () => {
  it('round-trips a ryuukyoku with a pon back to the same rivers', () => {
    const s = 'e1 5z123456789p1234z 5z5z123456789s12z 123456789s1234z 123456789p1234z 5z p 1s ryuukyoku';
    const g1 = parseStream(s).game;
    const text = gameToStream(g1);
    const g2 = parseStream(text).game;
    expect(rivers(g2)).toEqual(rivers(g1));
    expect(g2.kyokus[0].players[1].calls.some((c) => c.type === 'pon')).toBe(true);
  });

  it('round-trips a tsumo win (winner + tile recovered)', () => {
    const s = 'e1 123456789m1234z1z 123456789p1234z 123456789s1234z 23499m456678p23s 1z 9p 8p 9s 8s 4s tsumo';
    const g1 = parseStream(s).game;
    const g2 = parseStream(gameToStream(g1)).game;
    expect(rivers(g2)).toEqual(rivers(g1));
    expect(g2.kyokus[0].result.kind).toBe('tsumo');
    expect(g2.kyokus[0].result.winner).toBe(g1.kyokus[0].result.winner);
  });

  it('preserves riichi discards', () => {
    const s = 'e1 123456789p1234z5z 123456789s1234z 123456789m1234z 406789p11223s99m 5z 9m r9m 2s 9s ron';
    const g1 = parseStream(s).game;
    const text = gameToStream(g1);
    expect(text).toMatch(/r9m/);
    const g2 = parseStream(text).game;
    const riichiP = g2.kyokus[0].players.find((p) => p.turns.some((t) => t.riichi));
    expect(riichiP).toBeDefined();
  });

  it('emits a round token, dora, and names', () => {
    const s = 'e1 d5m Alice:5z123456789p1234z Bob:5z5z123456789s12z Carol:123456789s1234z Dave:123456789p1234z 5z p 1s ryuukyoku';
    const text = gameToStream(parseStream(s).game);
    expect(text).toMatch(/^e1/);
    expect(text).toMatch(/d5m/);
    expect(text).toMatch(/Alice:/);
    expect(text).toMatch(/Bob:/);
  });

  it('keeps the dealer haipai at 14 tiles so play re-aligns', () => {
    const s = 'e1 123456789m1234z1z 123456789p1234z 123456789s1234z 123456789p1234z 1z ryuukyoku';
    const text = gameToStream(parseStream(s).game);
    const dealerHaipai = text.split(/\s+/)[1]; // after the round token
    const tileCount = (dealerHaipai.match(/\d/g) ?? []).length; // digits pair with a suit letter each
    // 14 tiles → the notation should parse back to 14
    const { game } = parseStream('e1 ' + dealerHaipai + ' 123456789p1234z 123456789s1234z 123456789p1234z 1z ryuukyoku');
    expect(game.kyokus[0].players[0].haipai.length + 1).toBe(14); // haipai 13 + folded draw
    expect(tileCount).toBeGreaterThan(0);
  });
});
