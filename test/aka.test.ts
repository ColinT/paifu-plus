import { describe, it, expect } from 'vitest';
import { parseTileNotation, tilesToNotation, tileLabel, makeAka, isAka, normalizeRed, stripAka } from '../src/core/tiles.js';
import { parseStream } from '../src/stream/parse.js';
import { gameToTenhou, tenhouCompatible, hasNonTenhouTiles } from '../src/core/tenhou.js';
import { scoreWin } from '../src/score/index.js';
import type { WinContext } from '../src/score/types.js';

describe('aka dora on any tile', () => {
  it('parses the a/aka prefix', () => {
    expect(parseTileNotation('a7z')).toEqual([147]);      // aka chun
    expect(parseTileNotation('aka7z')).toEqual([147]);
    expect(parseTileNotation('a5p')).toEqual([52]);       // aka five → native red-five code
    expect(parseTileNotation('123a4m')).toEqual([11, 12, 13, 114]); // aka 4m mid-run
    expect(parseTileNotation('0m')).toEqual([51]);        // existing red-five notation still works
  });

  it('serializes aka with an "a" prefix and round-trips', () => {
    expect(tilesToNotation([147])).toBe('a7z');
    expect(tilesToNotation([11, 12, 13, 114])).toBe('123a4m');
    for (const s of ['a7z', '123a4m', '0m', 'a1m9p']) expect(tilesToNotation(parseTileNotation(s))).toBe(s);
  });

  it('labels and tile helpers', () => {
    expect(tileLabel(147)).toBe('aka chun');
    expect(tileLabel(114)).toBe('aka 4m');
    expect(isAka(147)).toBe(true);
    expect(isAka(51)).toBe(true);
    expect(isAka(47)).toBe(false);
    expect(normalizeRed(147)).toBe(47);
    expect(makeAka(47)).toBe(147);
    expect(makeAka(15)).toBe(51);
    expect(stripAka(147)).toBe(47);
    expect(stripAka(51)).toBe(51); // native red-fives survive
  });

  it('an aka on any tile adds one dora han', () => {
    const base = (over: Partial<WinContext>): WinContext => ({
      concealed: [], melds: [], winningTile: 11, isTsumo: false,
      seatWind: 28, roundWind: 27, doraIndicators: [], uraIndicators: [], rules: {}, ...over,
    });
    const hand = { concealed: [12, 13, 14, 24, 25, 26, 26, 27, 28, 32, 33, 19, 19], winningTile: 34, isTsumo: true, riichi: true };
    const plain = scoreWin(base(hand));
    const withAka = scoreWin(base({ ...hand, concealed: [112, 13, 14, 24, 25, 26, 26, 27, 28, 32, 33, 19, 19] })); // 2m → aka 2m
    expect(withAka.valid).toBe(true);
    expect(withAka.han).toBe(plain.han + 1);
    expect(withAka.yaku.find((y) => y.name === 'ドラ')?.han).toBe(1);
  });

  it('tenhou export strips arbitrary aka to the plain tile', () => {
    const s = 'e1 123456789m1234z1z 123456789p1234z 123456789s1234z 123456789p1234z 1z a7z tsumo';
    const game = parseStream(s).game;
    const faithful = gameToTenhou(game);
    const compat = gameToTenhou(tenhouCompatible(game));
    expect((faithful.log[0] as any[])[8]).toContain(147); // South's draw = aka chun (faithful)
    expect((compat.log[0] as any[])[8]).toContain(47);    // stripped to plain chun
    expect((compat.log[0] as any[])[8]).not.toContain(147);
  });

  it('detects non-tenhou tiles for the export warning', () => {
    const withAka = parseStream('e1 123456789m1234z1z 123456789p1234z 123456789s1234z 123456789p1234z 1z a7z tsumo').game;
    const plain = parseStream('e1 123456789m1234z1z 123456789p1234z 123456789s1234z 123456789p1234z 1z 9p tsumo').game;
    expect(hasNonTenhouTiles(withAka)).toBe(true);
    expect(hasNonTenhouTiles(plain)).toBe(false);
    expect(hasNonTenhouTiles(tenhouCompatible(withAka))).toBe(false); // stripped copy is clean
  });

  it('reads an aka drawn tile from the stream', () => {
    const game = parseStream('e1 123456789m1234z1z 123456789p1234z 123456789s1234z 123456789p1234z 1z a7z tsumo').game;
    // South (seat 1) drew the aka chun
    expect(game.kyokus[0].players[1].turns.some((t) => t.draw === 147)).toBe(true);
  });
});
