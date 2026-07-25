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

  it('relative pon: East discards 2m, spon ⇒ North pons (+ backfills haipai)', () => {
    //                                     N haipai has 11 tiles, no 2m
    const s = 'e1 123456789m1234z1z 123456789p1234z 123456789s1234z 345678999m12z 2m spon 9m ryuukyoku';
    const { game, diagnostics } = parseStream(s);
    const north = game.kyokus[0].players[3];
    expect(north.calls.some((c) => c.type === 'pon' && c.calledTile === 12)).toBe(true);
    expect(north.haipai.filter((t) => t === 12).length).toBe(2); // backfilled two 2m
    expect(diagnostics.some((d) => /backfill/i.test(d.message))).toBe(true);
    // East's discarded 2m was claimed → marked called.
    const east = game.kyokus[0].players[0];
    expect(east.turns.find((t) => t.discard === 12)?.called).toBe(true);
  });

  it('relative pon maps t/k/s to toimen/kamicha/shimocha of the caller', () => {
    // East (seat0) discards; caller for each relative prefix:
    const mk = (pfx: string) => {
      const s = `e1 123456789m1234z1z 111p123456789p 111s123456789s 111z1234567z11m 1m ${pfx}pon 9m ryuukyoku`;
      const g = parseStream(s).game.kyokus[0];
      return [0, 1, 2, 3].find((seat) => g.players[seat].calls.some((c) => c.type === 'pon'));
    };
    expect(mk('t')).toBe(2); // toimen of East = West
    expect(mk('k')).toBe(1); // kamicha-pon: caller is East's shimocha = South
    expect(mk('s')).toBe(3); // shimocha-pon: caller is East's kamicha = North
  });

  it('? in the haipai phase skips that seat (does not consume the next token)', () => {
    // East has a partial known haipai; S/W/N skipped; 2z is East's first discard.
    const { game, diagnostics } = parseStream('e1 d7p 5567m ? ? ? 2z');
    const k = game.kyokus[0];
    expect(k.players[0].haipai).toEqual([15, 15, 16, 17]); // 5m5m6m7m
    expect(k.players[1].haipai).toEqual([]);               // South skipped
    expect(k.players[2].haipai).toEqual([]);
    expect(k.players[3].haipai).toEqual([]);
    // 2z is East's first discard, not South's haipai
    expect(k.players[0].turns.at(-1)?.discard).toBe(42);   // 2z = South wind (42)
    expect(diagnostics.filter((d) => /haipai skipped/.test(d.message))).toHaveLength(3);
  });

  it('flags ? as missing but keeps parsing', () => {
    const s = 'e1 1112345678999m 123456789p1234z5z 123456789s1234z5z 123456789p1234z5z 1z ? 8p ryuukyoku';
    const { missing, diagnostics } = parseStream(s);
    expect(missing).toBe(1);
    expect(diagnostics.some((d) => /missed/.test(d.message))).toBe(true);
  });

  it('auto-scores a tsumo win (pinfu + menzen tsumo)', () => {
    const s = 'e1 123456789m1234z1z 123456789p1234z 123456789s1234z 23499m456678p23s 1z 9p 8p 9s 8s 4s tsumo';
    const { game } = parseStream(s);
    const r = game.kyokus[0].result;
    expect(r.kind).toBe('tsumo');
    expect(r.winner).toBe(3);
    expect(r.han).toBe(2);
    expect(r.fu).toBe(20);
    expect(r.deltas).toEqual([-700, -400, -400, 1500]);
    expect(r.yaku?.map((y) => y.name)).toEqual(expect.arrayContaining(['平和', '門前清自摸和']));
  });

  it('computes ryuukyoku tenpai payments', () => {
    // North is tenpai (13-tile wait), others noten; simplest: end immediately after haipai
    const s = 'e1 123456789m1234z1z 133557799p1133s 133557799s1133m 23499m456678p23s 1z ryuukyoku';
    const { game } = parseStream(s);
    const r = game.kyokus[0].result;
    expect(r.kind).toBe('ryuukyoku');
    // exactly the tenpai seats gain; total is zero-sum
    expect(r.deltas.reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('starts a new kyoku on the next round token', () => {
    const s = 'e1 1112345678999m 123456789p1234z5z 123456789s1234z5z 123456789p1234z5z 1z ryuukyoku '
            + 'e2 1112345678999m 123456789p1234z5z 123456789s1234z5z 123456789p1234z5z 1z ryuukyoku';
    const { game } = parseStream(s);
    expect(game.kyokus).toHaveLength(2);
    expect(game.kyokus[1].round).toBe(1);
  });
});
