/**
 * Hand representation for scoring.
 *
 * Scoring works in "34-index" space, independent of aka/red flags:
 *   0..8   = 1m..9m
 *   9..17  = 1p..9p
 *   18..26 = 1s..9s
 *   27..33 = E, S, W, N, haku, hatsu, chun
 *
 * Aka-five information is tracked separately (as a count) for dora only.
 */

import type { TenhouTile } from '../core/tiles.js';

export const MAN = 0, PIN = 9, SOU = 18, HONOR = 27;

/** tenhou code → 34-index (reds normalized to their plain five). */
export function toIndex(t: TenhouTile): number {
  if (t === 51) return MAN + 4;
  if (t === 52) return PIN + 4;
  if (t === 53) return SOU + 4;
  if (t >= 41) return HONOR + (t - 41);
  const suit = Math.floor(t / 10), rank = t % 10;
  const base = suit === 1 ? MAN : suit === 2 ? PIN : SOU;
  return base + (rank - 1);
}

/** 34-index → representative tenhou code (plain, never aka). */
export function fromIndex(i: number): TenhouTile {
  if (i >= HONOR) return 41 + (i - HONOR);
  const suit = Math.floor(i / 9), rank = (i % 9) + 1;
  return (suit === 0 ? 10 : suit === 1 ? 20 : 30) + rank;
}

export function isHonor(i: number): boolean { return i >= HONOR; }
export function isTerminal(i: number): boolean { return !isHonor(i) && (i % 9 === 0 || i % 9 === 8); }
export function isTerminalOrHonor(i: number): boolean { return isHonor(i) || isTerminal(i); }
export function suitOf(i: number): number { return i < HONOR ? Math.floor(i / 9) : 3; }
export function rankOf(i: number): number { return i < HONOR ? (i % 9) + 1 : 0; }

/** Can a sequence start at 34-index i (i, i+1, i+2 in the same numbered suit)? */
export function canSequence(i: number): boolean {
  return i < HONOR && i % 9 <= 6;
}

/** Build a counts[34] array from tenhou tiles. */
export function counts(tiles: TenhouTile[]): number[] {
  const c = new Array(34).fill(0);
  for (const t of tiles) c[toIndex(t)]++;
  return c;
}

/** Count aka fives among tiles. */
export function akaCount(tiles: TenhouTile[]): number {
  return tiles.filter((t) => t === 51 || t === 52 || t === 53).length;
}

/** The dora tile produced by an indicator (next in sequence, wrapping). */
export function doraFromIndicator(indicator: TenhouTile): number {
  const i = toIndex(indicator);
  if (i >= HONOR) {
    const h = i - HONOR;
    if (h <= 3) return HONOR + ((h + 1) % 4);         // winds E→S→W→N→E
    return HONOR + 4 + ((h - 4 + 1) % 3);              // dragons haku→hatsu→chun→haku
  }
  const suit = Math.floor(i / 9), rank = i % 9;         // 0..8
  return suit * 9 + ((rank + 1) % 9);
}
