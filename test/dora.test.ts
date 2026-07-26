import { describe, it, expect } from 'vitest';
import { indicatorToDora, doraToIndicator } from '../src/core/tiles.js';
import { parseStream } from '../src/stream/parse.js';
import { gameToTenhou } from '../src/core/tenhou.js';
import { gameToStream } from '../src/stream/serialize.js';
import { tenhouToGame } from '../src/core/tenhouImport.js';

describe('dora ↔ indicator', () => {
  it('converts with wrapping, both ways', () => {
    expect(indicatorToDora(26)).toBe(27); // 6p → 7p
    expect(doraToIndicator(27)).toBe(26); // 7p → 6p
    expect(indicatorToDora(19)).toBe(11); // 9m → 1m
    expect(doraToIndicator(11)).toBe(19); // 1m → 9m
    expect(indicatorToDora(44)).toBe(41); // N → E
    expect(doraToIndicator(41)).toBe(44); // E → N
    expect(indicatorToDora(47)).toBe(45); // chun → haku
    expect(doraToIndicator(45)).toBe(47); // haku → chun
    expect(doraToIndicator(53)).toBe(34); // red 5s dora → 4s indicator
  });

  it('DSL "d7p" = dora 7p, but tenhou JSON stores the indicator 6p', () => {
    const s = 'e1 d7p 123456789m1234z1z 123456789p1234z 123456789s1234z 123456789p1234z 1z ryuukyoku';
    const game = parseStream(s).game;
    expect(game.kyokus[0].doraIndicators).toEqual([26]);          // 6p indicator stored
    expect((gameToTenhou(game).log[0] as any[])[2]).toEqual([26]); // tenhou dora field = indicator
    expect(gameToStream(game)).toMatch(/d7p/);                     // serializes back to the dora
  });

  it('tenhou JSON indicators survive a round-trip and display as the dora', () => {
    const s = 'e1 d7p 123456789m1234z1z 123456789p1234z 123456789s1234z 123456789p1234z 1z ryuukyoku';
    const log1 = gameToTenhou(parseStream(s).game);
    const log2 = gameToTenhou(tenhouToGame(log1));
    expect(log2).toEqual(log1); // indicator [26] preserved unchanged
  });

  it('DSL "di5p" sets the indicator directly (6p dora), same as "d6p"', () => {
    const base = ' 123456789m1234z1z 123456789p1234z 123456789s1234z 123456789p1234z 1z ryuukyoku';
    const di = parseStream('e1 di5p' + base).game;
    const d = parseStream('e1 d6p' + base).game;
    expect(di.kyokus[0].doraIndicators).toEqual([25]); // 5p indicator
    expect(d.kyokus[0].doraIndicators).toEqual([25]);  // 6p dora → 5p indicator
  });

  it('"dia5p" / "di0p" transcribe a red-five indicator, and it survives serialize', () => {
    const base = ' 123456789m1234z1z 123456789p1234z 123456789s1234z 123456789p1234z 1z ryuukyoku';
    for (const tok of ['dia5p', 'di0p']) {
      const game = parseStream('e1 ' + tok + base).game;
      expect(game.kyokus[0].doraIndicators).toEqual([52]); // native red-five 5p indicator
      // an aka indicator can't be a plain "d" token, so it serialises as "di0p"
      expect(gameToStream(game)).toMatch(/di0p/);
      // and re-parses to the same red-five indicator
      expect(parseStream(gameToStream(game)).game.kyokus[0].doraIndicators).toEqual([52]);
    }
  });

  it('ura indicator form "ui" mirrors "di"', () => {
    const s = 'e1 di3m ui0s 123456789m1234z1z 123456789p1234z 123456789s1234z 123456789p1234z 1z ryuukyoku';
    const k = parseStream(s).game.kyokus[0];
    expect(k.doraIndicators).toEqual([13]); // 3m indicator
    expect(k.uraIndicators).toEqual([53]);  // red-five 5s ura indicator
  });
});
