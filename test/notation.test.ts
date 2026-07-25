import { describe, it, expect } from 'vitest';
import { parseTileNotation, tilesToNotation } from '../src/core/tiles.js';

describe('tile notation', () => {
  it('parses suited runs', () => {
    expect(parseTileNotation('123m')).toEqual([11, 12, 13]);
    expect(parseTileNotation('123m456p789s')).toEqual([11, 12, 13, 24, 25, 26, 37, 38, 39]);
  });
  it('parses honors via z (1-7 = E S W N haku hatsu chun)', () => {
    expect(parseTileNotation('1234567z')).toEqual([41, 42, 43, 44, 45, 46, 47]);
  });
  it('parses red fives as 0', () => {
    expect(parseTileNotation('0m0p0s')).toEqual([51, 52, 53]);
  });
  it('ignores spaces and stray characters', () => {
    expect(parseTileNotation('123m, 45p  6s')).toEqual([11, 12, 13, 24, 25, 36]);
  });
  it('round-trips through notation, grouping consecutive suits', () => {
    const codes = [11, 12, 13, 24, 25, 51, 47];
    expect(tilesToNotation(codes)).toBe('123m45p0m7z');
    expect(parseTileNotation(tilesToNotation(codes))).toEqual(codes);
  });
});
