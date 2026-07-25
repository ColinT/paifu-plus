import { describe, it, expect } from 'vitest';
import { parseStream } from '../src/stream/parse.js';
import { gameToTenhou } from '../src/core/tenhou.js';
import { tenhouToGame } from '../src/core/tenhouImport.js';

/** The decoder is the inverse the editor⇄replay sync relies on: a log fed back
 *  through tenhouToGame → gameToTenhou must reproduce the same log, or toggling
 *  between the two tools would drift. */
function stableLog(stream: string) {
  const game = parseStream(stream).game;
  const log1 = gameToTenhou(game);
  const log2 = gameToTenhou(tenhouToGame(log1));
  return { log1, log2 };
}

describe('tenhouToGame (replay → editor)', () => {
  it('round-trips a ryuukyoku with a pon', () => {
    const s = 'e1 5z123456789p1234z 5z5z123456789s12z 123456789s1234z 123456789p1234z 5z p 1s ryuukyoku';
    const { log1, log2 } = stableLog(s);
    expect(log2).toEqual(log1);
  });

  it('round-trips a tsumo win (final draw, no discard)', () => {
    const s = 'e1 123456789m1234z1z 123456789p1234z 123456789s1234z 23499m456678p23s 1z 9p 8p 9s 8s 4s tsumo';
    const { log1, log2 } = stableLog(s);
    expect(log2).toEqual(log1);
  });

  it('round-trips a riichi + ron', () => {
    const s = 'e1 123456789p1234z 123456789s1234z 123456789m1234z 406789p11223s99m 1z 9m r9m 2s 9s ron';
    const { log1, log2 } = stableLog(s);
    expect(log2).toEqual(log1);
  });

  it('preserves meta (names, title, aka) and per-player streams', () => {
    const s = 'e1 Alice:5z123456789p1234z Bob:5z5z123456789s12z Carol:123456789s1234z Dave:123456789p1234z 5z p 1s ryuukyoku';
    const game = tenhouToGame(gameToTenhou(parseStream(s).game));
    expect(game.meta.names).toEqual(['Alice', 'Bob', 'Carol', 'Dave']);
    // Bob (South) claimed East's 5z as a pon.
    expect(game.kyokus[0].players[1].calls.some((c) => c.type === 'pon')).toBe(true);
  });

  it('recovers the winning tile and result kind for a ron', () => {
    const s = 'e1 123456789p1234z 123456789s1234z 123456789m1234z 406789p11223s99m 1z 9m r9m 2s 9s ron';
    const game = tenhouToGame(gameToTenhou(parseStream(s).game));
    const r = game.kyokus[0].result;
    expect(r.kind).toBe('ron');
    expect(r.winner).toBeTypeOf('number');
    expect(r.winningTile).toBeDefined();
  });
});
