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
 *   - any dedicated aka-five artwork (see AKA note below)
 */

import type { TenhouTile } from '../core/tiles.js';

/** Special non-tile glyph found in the ツモ rows. */
export const ARROW_HASH = '72f6445067'; // ↓ tsumogiri marker (in ツモ rows)

// NOTE: e169ea36ab is 白 (haku / white dragon), which this tileset renders as a
// blank-framed tile — NOT a spacer. It maps to 45 in PORTRAIT_TILE below.

/**
 * AKA (red five) note: 5m is `f57dd0196d` (伍萬). The original table also listed
 * `7fc3a99459` as a second 5m glyph, but ground truth (South 344589m…) shows it
 * is actually 三萬 = 3m — the 三/五 strokes were misread. 5p/5s each have a single
 * red-centre image. Whether this ruleset uses red fives is unconfirmed (最高位戦
 * classical rules often do not), so 5m/5p/5s map to plain 15/25/35; if aka is in
 * play, remap the aka glyph to 51/52/53 and set rule.aka=1.
 */
export const PORTRAIT_TILE: Record<string, TenhouTile> = {
  // man — 7fc3a99459 is 3m (was mis-mapped to 5m); confirmed against South 344589m.
  '5d027c18d8': 11, '330858f1f8': 12, 'ddc9df43bb': 13, '7fc3a99459': 13, 'f4e77c078c': 14,
  'f57dd0196d': 15, '19481ddc8a': 16, 'e398c082b1': 17,
  '29f63b7bad': 18, '97334621e1': 19,
  // pin — 6p/8p/9p were mutually swapped in the original table; corrected against
  // ground truth (East 88m78899p…, South …126p…): 6p=58c1e321c9, 8p=5ace38e2ee,
  // 9p=2ef6d6f3c1. 3p has no confirmed hash in the samples (6bb997486b, formerly
  // 3p, is actually 9s — see sou).
  '4a72cf9698': 21, '44049c411f': 22, 'c375c84202': 24,
  '20bebe2b52': 25, '58c1e321c9': 26, '0b116e2f56': 27, '5ace38e2ee': 28,
  '2ef6d6f3c1': 29,
  // sou — 7s/8s/9s were all mis-mapped (and 6bb997486b, formerly 3p, is 7s);
  // corrected against ground truth (West sorted …112789s…, North …23448s…):
  // 7s=6bb997486b, 8s=f72b43f932, 9s=d47e660b2f.
  'dc1046fb00': 31, '39744bbbbc': 32, '76227a4ace': 33, '9472c85b35': 34,
  '2f69759175': 35, 'bf842de9c2': 36, '6bb997486b': 37, 'f72b43f932': 38,
  'd47e660b2f': 39,
  // honors — 20d8a4cc2c (formerly 8s) is 發 hatsu; confirmed against North …1556z.
  'b5cf7d046c': 41, '1d42bff19c': 42, 'fff3043152': 43, 'd14217155f': 44,
  'e169ea36ab': 45, '20d8a4cc2c': 46, '26a4dc27eb': 47,
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
  | { kind: 'unknown'; hash: string };

/** Classify a tile image by its content hash. */
export function classifyHash(hash: string): TileKind {
  if (hash === ARROW_HASH) return { kind: 'arrow' };
  if (hash in PORTRAIT_TILE) return { kind: 'tile', tile: PORTRAIT_TILE[hash], landscape: false };
  if (hash in LANDSCAPE_TILE) return { kind: 'tile', tile: LANDSCAPE_TILE[hash], landscape: true };
  return { kind: 'unknown', hash };
}
