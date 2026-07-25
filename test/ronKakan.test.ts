import { describe, it, expect } from 'vitest';
import { parseStream } from '../src/stream/parse.js';
import { gameToStream } from '../src/stream/serialize.js';
import { gameToTenhou } from '../src/core/tenhou.js';
import { tenhouToGame } from '../src/core/tenhouImport.js';

describe('ron seat prefixes', () => {
  it('attributes a single-seat ron to the named winner (not the inferred next seat)', () => {
    // East discards 1z; West (seat 2) declares ron on it.
    const s = 'e1 123456789m1234z1z 123456789p1234z 123456789s1234z 123456789p1235z 1z wron';
    const r = parseStream(s).game.kyokus[0].result;
    expect(r.kind).toBe('ron');
    expect(r.winner).toBe(2); // West
    expect(r.loser).toBe(0);  // East dealt in
  });

  it('records two winners for a double ron and emits two tenhou win-details', () => {
    // South discards 2z; West (2) and North (3) both ron.
    const s = 'e1 123456789m1234z1z 123456789p1234z 123456789s1234z 123456789p1235z 1z 9p 2z wnron';
    const g = parseStream(s).game;
    const r = g.kyokus[0].result;
    expect(r.kind).toBe('ron');
    expect(r.wins?.length).toBe(2);
    expect(r.wins?.map((w) => w.winner).sort()).toEqual([2, 3]);
    expect(r.loser).toBe(1); // South

    // tenhou result array: '和了' then one (deltas, detail) pair per winner.
    const result = (gameToTenhou(g).log[0] as any[])[16] as any[];
    expect(result[0]).toBe('和了');
    const details = result.filter((_, i) => i >= 2 && i % 2 === 0 && Array.isArray(result[i]));
    expect(details.length).toBe(2);
  });

  it('round-trips a double ron through the importer', () => {
    const s = 'e1 123456789m1234z1z 123456789p1234z 123456789s1234z 123456789p1235z 1z 9p 2z wnron';
    const log1 = gameToTenhou(parseStream(s).game);
    const log2 = gameToTenhou(tenhouToGame(log1));
    expect(log2).toEqual(log1);
  });

  it('serializes a double ron back to a seat-prefixed token', () => {
    const s = 'e1 123456789m1234z1z 123456789p1234z 123456789s1234z 123456789p1235z 1z 9p 2z wnron';
    const text = gameToStream(parseStream(s).game);
    expect(text).toMatch(/wnron\b/);
  });
});

describe('kakan (added kan)', () => {
  const s = [
    'e1',
    'E:123456789m1122z2s',   // dealer, 14 tiles; discards 2s first
    'S:2s2s123m123p456s77z',  // holds two 2s → can pon
    'W:123456789m1234z',
    'N:123456789p1234z',
    '2s', 'kpon', '7z',       // E discards 2s; S pons (kamicha); S discards 7z
    '5m', 'x5m',              // W
    '5p', 'x5p',              // N
    '3z', 'x3z',              // E
    '2s', 'kan',              // S draws the 4th 2s and adds it (kakan)
    '6z', 'x6z',              // S rinshan draw + discard
    'ryuukyoku',
  ].join(' ');

  it('parses the pon-then-add as a kakan call', () => {
    const g = parseStream(s).game;
    const south = g.kyokus[0].players[1];
    expect(south.calls.some((c) => c.type === 'kakan')).toBe(true);
    const kakan = south.calls.find((c) => c.type === 'kakan')!;
    expect(kakan.kanTurn).toBeGreaterThan(kakan.turn); // upgrade happened after the claim
  });

  it('round-trips a kakan through the tenhou importer', () => {
    const log1 = gameToTenhou(parseStream(s).game);
    const log2 = gameToTenhou(tenhouToGame(log1));
    expect(log2).toEqual(log1);
  });

  it('round-trips a kakan through serialize → parse (still a kakan)', () => {
    const g1 = parseStream(s).game;
    const g2 = parseStream(gameToStream(g1)).game;
    expect(g2.kyokus[0].players[1].calls.some((c) => c.type === 'kakan')).toBe(true);
  });

  it('accepts an explicit kakan tile (kakan2s)', () => {
    const explicit = s.replace('2s kan', '2s kakan2s');
    const g = parseStream(explicit).game;
    expect(g.kyokus[0].players[1].calls.some((c) => c.type === 'kakan')).toBe(true);
  });
});
