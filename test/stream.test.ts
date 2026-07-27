import { describe, it, expect } from 'vitest';
import { parseStream } from '../src/stream/parse.js';
import { gameToStream } from '../src/stream/serialize.js';

describe('stream transcription DSL', () => {
  it('parses round, dora, haipai (dealer 14→13), riichi sticks', () => {
    const s = 'e1.0 d5m 123456789m1234z1z 123456789p1122s 123456789s1123p 1122334455667z 1z 9p 8p 9s x 3z r7z ryuukyoku';
    const { game, missing } = parseStream(s);
    expect(missing).toBe(0);
    expect(game.kyokus).toHaveLength(1);
    const k = game.kyokus[0];
    expect([k.round, k.honba]).toEqual([0, 0]);
    expect(k.doraIndicators).toEqual([14]); // d5m = dora 5m → indicator 4m (14)
    for (const p of k.players) expect(p.haipai).toHaveLength(13);
    expect(k.players[3].turns.some((t) => t.riichi)).toBe(true); // North riichi'd
    expect(k.result.kind).toBe('ryuukyoku');
  });

  it('parses space-separated player names (name then haipai)', () => {
    const s = 'e1 Okada 123456789m1234z1z Asakura 123456789p1234z Sekiguchi 123456789s1234z Mizukoshi 123456789p1234z 1z ryuukyoku';
    const g = parseStream(s).game.kyokus[0];
    expect(g.players.map((p) => p.name)).toEqual(['Okada', 'Asakura', 'Sekiguchi', 'Mizukoshi']);
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
    expect(north.haipai.filter((t) => t === 12).length).toBe(2); // silently backfilled two 2m
    void diagnostics;
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
    // East's partial haipai (5m5m6m7m); the discarded 2z it didn't hold is
    // reconciled back into the haipai as coming from the unrecorded tiles.
    expect(k.players[0].haipai).toEqual([15, 15, 16, 17, 42]);
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

  it('dealer keeps the folded 14th tile in hand (legal to discard it)', () => {
    // East (dealer) discards its 14th/folded tile (8m) on the first turn.
    const s = 'e1 11223344556678m 123456789p1234z 123456789s1234z 123456789p1234z 8m ryuukyoku';
    const { diagnostics } = parseStream(s);
    expect(diagnostics.some((d) => /hold/.test(d.message))).toBe(false);
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

  it('debits the riichi stick so a win balances to zero', () => {
    // Sekiguchi rons Asakura for 3900; Asakura had declared riichi (r5z), so
    // Asakura loses 3900 + 1000 (stick) and Sekiguchi gains 3900 + 1000 (collects it).
    const s = 'e1 d7p Okada 996p7765m248s2447z Asakura 189m78p5z9966s661z Sekiguchi 23577p33z7z1238m2s Mizukoshi 249m357z1248p458s '
      + '2z 8p 1m 7s 8m 1s 3z wpon 7z 5p 1s 5s 7z 8m 1z 2z x 5m 9m 8s 2s 9m r5z 6p 2s 3s 5z 3p 4z 4m x 6m 7s 1s 4m 6z 4z 5z x 6m x 2p '
      + '7z 9s 6m 5s x 7s 6m 7z 5s 3s 5s 1m x 3m 7s 1z x 3p 7m 9p x 4p 3m 3s 7z 6z 7m 2p x 4s x 7m 2p 6s 4s 1p x ron';
    const r = parseStream(s).game.kyokus[0].result;
    expect(r.kind).toBe('ron');
    expect(r.deltas).toEqual([0, -4900, 4900, 0]);
    expect(r.deltas.reduce((a, b) => a + b, 0)).toBe(0); // balances
  });

  it('bare ron picks the seat whose hand completes, not a turn-order guess', () => {
    // Partial haipai reconciled from the discards; West (Sekiguchi) is the only
    // tenpai hand, so a bare "ron" must attribute the win to West — with no
    // spurious "no yaku" / "out of step" warnings.
    const s = 'e1 Asakura:46789p35s157z1358m Mizukoshi:23347m6z789s25p Sekiguchi:77z112267p2s Okada:888421m44s4z137p '
      + '7z tpon 5s 3z x 6m 1z 8s 9p 1s 7s 2m 1m 4s 8m 8p 6z 6s x 2s 4z 8s x 5z x 8p 7m 4p 1p spon 2z 1z x 3m 1m 9m 8s 3p '
      + 'x 2m 4m 4z x 5p 2z 6m x 4m x 1m x 6z x 6s x 3z 4s 6s 3s ron';
    const { game, diagnostics } = parseStream(s);
    expect(game.kyokus[0].result.winner).toBe(2); // West = Sekiguchi
    expect(diagnostics.filter((d) => d.severity === 'warn')).toHaveLength(0);
  });

  it('parses starting scores (name:score:tiles and space form), defaulting to 25000', () => {
    const base = ' 123456789p1234z 123456789s1234z 123456789p1234z 1z ryuukyoku';
    const colon = parseStream('e1 Okada:24000:123456789m1234z1z' + base).game.kyokus[0];
    expect([colon.players[0].name, colon.players[0].startScore]).toEqual(['Okada', 24000]);
    const space = parseStream('e1 Okada 31000 123456789m1234z1z' + base).game.kyokus[0];
    expect([space.players[0].name, space.players[0].startScore]).toEqual(['Okada', 31000]);
    const def = parseStream('e1 Okada:123456789m1234z1z' + base).game.kyokus[0];
    expect(def.players[0].startScore).toBe(25000); // omitted ⇒ default
    // survives a serialize round-trip
    expect(parseStream(gameToStream(colon2game('Okada', 24000))).game.kyokus[0].players[0].startScore).toBe(24000);
    function colon2game(n: string, sc: number) { return parseStream(`e1 ${n}:${sc}:123456789m1234z1z${base}`).game; }
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
