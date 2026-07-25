import { describe, it, expect } from 'vitest';
import { parseStream } from '../src/stream/parse.js';

describe('stream transcription DSL', () => {
  it('parses round, dora, haipai (dealer 14→13), riichi sticks', () => {
    const s = 'e1.0 d5m 123456789m1234z1z 123456789p1122s 123456789s1123p 1122334455667z 1z 9p 8p 9s x 3z r7z ryuukyoku';
    const { game, missing } = parseStream(s);
    expect(missing).toBe(0);
    expect(game.kyokus).toHaveLength(1);
    const k = game.kyokus[0];
    expect([k.round, k.honba]).toEqual([0, 0]);
    expect(k.doraIndicators).toEqual([15]);
    for (const p of k.players) expect(p.haipai).toHaveLength(13);
    expect(k.players[3].turns.some((t) => t.riichi)).toBe(true); // North riichi'd
    expect(k.result.kind).toBe('ryuukyoku');
  });

  it('flexible round syntax e1 / E1 / e1-0 all mean East-1', () => {
    for (const r of ['e1', 'E1', 'e1-0', 'e1.0.0']) {
      const { game } = parseStream(`${r} 1m 2m3m4m5m6m7m8m9m1z2z3z4z5z 1p2p3p4p5p6p7p8p9p1s2s3s4s 1s2s3s4s5s6s7s8s9s1p2p3p4p 1z2z3z4z5z6z7z1m2m3m4m5m6m ryuukyoku`);
      expect(game.kyokus[0].round).toBe(0);
    }
  });

  it('attributes a pon to the holder and continues with their discard', () => {
    // South holds two 1z; East discards 1z; South pons and discards 9p.
    const s = 'e1 1112345678999m 1p1z1z2233445566s 123456789s1234z5z 123456789p1234z5z 1z p 9p ryuukyoku';
    const { game } = parseStream(s);
    const k = game.kyokus[0];
    const south = k.players[1];
    expect(south.calls.some((c) => c.type === 'pon' && c.calledTile === 41)).toBe(true);
  });

  it('flags ? as missing but keeps parsing', () => {
    const s = 'e1 1112345678999m 123456789p1234z5z 123456789s1234z5z 123456789p1234z5z 1z ? 8p ryuukyoku';
    const { missing, diagnostics } = parseStream(s);
    expect(missing).toBe(1);
    expect(diagnostics.some((d) => /missed/.test(d.message))).toBe(true);
  });

  it('starts a new kyoku on the next round token', () => {
    const s = 'e1 1112345678999m 123456789p1234z5z 123456789s1234z5z 123456789p1234z5z 1z ryuukyoku '
            + 'e2 1112345678999m 123456789p1234z5z 123456789s1234z5z 123456789p1234z5z 1z ryuukyoku';
    const { game } = parseStream(s);
    expect(game.kyokus).toHaveLength(2);
    expect(game.kyokus[1].round).toBe(1);
  });
});
