/** Visual rendering of tenhou tile codes as Unicode mahjong glyphs. */

import type { TenhouTile } from './tiles.js';
import { normalizeRed, isRedFive, tileLabel } from './tiles.js';

// Unicode Mahjong Tiles block (U+1F000..). Honors and suits at fixed offsets.
const WIND = { 41: '🀀', 42: '🀁', 43: '🀂', 44: '🀃' } as Record<number, string>;
const DRAGON = { 45: '🀆', 46: '🀅', 47: '🀄' } as Record<number, string>; // haku, hatsu, chun

export function tileGlyph(t: TenhouTile): string {
  const n = normalizeRed(t);
  if (n >= 41 && n <= 44) return WIND[n];
  if (n >= 45 && n <= 47) return DRAGON[n];
  const suit = Math.floor(n / 10);
  const rank = n % 10;
  if (suit === 1) return String.fromCodePoint(0x1f007 + (rank - 1)); // man
  if (suit === 3) return String.fromCodePoint(0x1f010 + (rank - 1)); // sou
  if (suit === 2) return String.fromCodePoint(0x1f019 + (rank - 1)); // pin
  return '🀫';
}

/** Suit class for colouring: 'm' | 'p' | 's' | 'z', plus red flag. */
export function tileSuitClass(t: TenhouTile): { suit: string; red: boolean } {
  const n = normalizeRed(t);
  const red = isRedFive(t);
  if (n >= 41) return { suit: 'z', red };
  const suit = Math.floor(n / 10);
  return { suit: suit === 1 ? 'm' : suit === 2 ? 'p' : 's', red };
}

export { tileLabel };

/** All tiles in pick order for the tile picker: 1-9m, 1-9p, 1-9s, winds, dragons, + reds. */
export function allPickableTiles(): TenhouTile[] {
  const t: TenhouTile[] = [];
  for (let r = 1; r <= 9; r++) t.push(10 + r);
  for (let r = 1; r <= 9; r++) t.push(20 + r);
  for (let r = 1; r <= 9; r++) t.push(30 + r);
  for (let z = 1; z <= 7; z++) t.push(40 + z);
  t.push(51, 52, 53); // red fives
  return t;
}
