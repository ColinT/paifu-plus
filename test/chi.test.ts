import { describe, it, expect } from 'vitest';
import { parseStream } from '../src/stream/parse.js';
import { gameToStream } from '../src/stream/serialize.js';
import { normalizeRed } from '../src/core/tiles.js';

// East discards 5m; South (its shimocha, holding 3m4m6m7m) can chi with 345m,
// 456m, or 567m, then discards 1p; the hand ends in a draw.
const base = (call: string) =>
  `e1 5m123456789p1234s 34679m123p12345s 123456789m1234p 123456789s1234p 5m ${call} 1p ryuukyoku`;

/** The normalised run tiles of South's chi. */
function chiRun(text: string): number[] {
  const k = parseStream(text).game.kyokus[0];
  const caller = k.players.find((p) => p.calls.some((c) => c.type === 'chi'))!;
  const chi = caller.calls.find((c) => c.type === 'chi')!;
  return chi.tiles.map(normalizeRed).sort((a, b) => a - b);
}

describe('chi run disambiguation', () => {
  it('defaults to the lowest run in hand (345m)', () => {
    expect(chiRun(base('chi'))).toEqual([13, 14, 15]);
  });

  it('chi46m (two hand tiles) forces the 456m run', () => {
    expect(chiRun(base('chi46m'))).toEqual([14, 15, 16]);
  });

  it('chi456m (whole run) forces the 456m run', () => {
    expect(chiRun(base('chi456m'))).toEqual([14, 15, 16]);
  });

  it('chi67m forces the 567m run', () => {
    expect(chiRun(base('chi67m'))).toEqual([15, 16, 17]);
  });

  it('warns when the named tiles do not form a run with the called tile', () => {
    const r = parseStream(base('chi35m'));
    expect(r.diagnostics.some((d) => /run/.test(d.message))).toBe(true);
  });

  it('warns on an ambiguous chi when no run is named (hand allows several)', () => {
    const r = parseStream(base('chi'));
    expect(r.diagnostics.some((d) => d.severity === 'warn' && /ambiguous chi/.test(d.message))).toBe(true);
  });

  it('does not warn when a run is named, or when only one run is possible', () => {
    expect(parseStream(base('chi46m')).diagnostics.some((d) => /ambiguous chi/.test(d.message))).toBe(false);
    // Only 567m is possible: East discards 5m, South holds 67m (no 3m/4m).
    const one = 'e1 5m123456789p1234s 6789m123p123456s 123456789m1234p 123456789s1234p 5m chi 1p ryuukyoku';
    expect(parseStream(one).diagnostics.some((d) => /ambiguous chi/.test(d.message))).toBe(false);
  });

  it('round-trips: the chosen run survives gameToStream → parseStream', () => {
    const g = parseStream(base('chi46m')).game;
    const stream = gameToStream(g);
    expect(stream).toMatch(/chi\S*6m/); // emits the hand tiles, not a bare "chi"
    expect(chiRun(stream)).toEqual([14, 15, 16]);
  });
});
