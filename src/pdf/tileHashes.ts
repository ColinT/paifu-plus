/**
 * Content-hash → tile lookup for the PAIFUN (最高位戦) tile artwork.
 *
 * The PDF draws tiles as reused image XObjects. The XObject *names* are not
 * stable across files, but the decoded pixel content is, so we key on an MD5
 * of the raw image bytes (first 10 hex chars — collision-safe for ~40 tiles).
 *
 * These hashes were identified from the three sample hands (ketteisen1-1/2/4)
 * and verified against user-provided ground truth. See scripts/build-tile-
 * montage.mjs to regenerate/extend the montage when new artwork appears.
 *
 * NOT YET SEEN in samples (will be unmapped until a hand uses them):
 *   - 白 haku (45), 發 hatsu (46)
 *   - any dedicated aka-five artwork (see AKA note below)
 */

import type { TenhouTile } from '../core/tiles.js';

/** Special non-tile glyphs found in the tile rows. */
export const ARROW_HASH = '72f6445067'; // ↓ tsumogiri marker (in ツモ rows)
export const BLANK_HASH = 'e169ea36ab'; // empty spacer tile

/**
 * AKA (red five) note: two distinct 5m glyphs exist (伍萬 `f57dd0196d`,
 * 五萬 `7fc3a99459`); 5p/5s each have a single red-centre image. Whether this
 * ruleset uses red fives is unconfirmed (最高位戦 classical rules often do not),
 * so BOTH 5m map to plain 15 and 5p/5s map to plain 25/35. If aka is in play,
 * remap one 5m glyph to 51 and set rule.aka=1.
 */
export const PORTRAIT_TILE: Record<string, TenhouTile> = {
  // man
  '5d027c18d8': 11, '330858f1f8': 12, 'ddc9df43bb': 13, 'f4e77c078c': 14,
  'f57dd0196d': 15, '7fc3a99459': 15, '19481ddc8a': 16, 'e398c082b1': 17,
  '29f63b7bad': 18, '97334621e1': 19,
  // pin
  '4a72cf9698': 21, '44049c411f': 22, '6bb997486b': 23, 'c375c84202': 24,
  '20bebe2b52': 25, '2ef6d6f3c1': 26, '0b116e2f56': 27, '58c1e321c9': 28,
  '5ace38e2ee': 29,
  // sou
  'dc1046fb00': 31, '39744bbbbc': 32, '76227a4ace': 33, '9472c85b35': 34,
  '2f69759175': 35, 'bf842de9c2': 36, 'd47e660b2f': 37, '20d8a4cc2c': 38,
  'f72b43f932': 39,
  // honors
  'b5cf7d046c': 41, '1d42bff19c': 42, 'fff3043152': 43, 'd14217155f': 44,
  '26a4dc27eb': 47,
};

/**
 * Landscape (rotated) called-meld tiles, keyed by content hash → face value.
 * The parser normally derives a called tile's face from its adjacent portrait
 * meld tiles; this map is a fallback / cross-check. `9d9734fedb` (6p) is
 * inferred from rotation and should be confirmed against its meld neighbours.
 */
export const LANDSCAPE_TILE: Record<string, TenhouTile> = {
  'e399034970': 47, // 中 (file 4 pon of chun) — confirmed via neighbours
  '9d9734fedb': 26, // 6p (file 1 pon) — tentative, confirm via neighbours
};

export type TileKind =
  | { kind: 'tile'; tile: TenhouTile; landscape: boolean }
  | { kind: 'arrow' }
  | { kind: 'blank' }
  | { kind: 'unknown'; hash: string };

/** Classify a tile image by its content hash. */
export function classifyHash(hash: string): TileKind {
  if (hash === ARROW_HASH) return { kind: 'arrow' };
  if (hash === BLANK_HASH) return { kind: 'blank' };
  if (hash in PORTRAIT_TILE) return { kind: 'tile', tile: PORTRAIT_TILE[hash], landscape: false };
  if (hash in LANDSCAPE_TILE) return { kind: 'tile', tile: LANDSCAPE_TILE[hash], landscape: true };
  return { kind: 'unknown', hash };
}
