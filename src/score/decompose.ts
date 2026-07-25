/** Decompose a hand into set partitions; detect complete hands and tenpai. */

import { canSequence } from './hand.js';

export type SetType = 'seq' | 'triplet' | 'pair';
export interface HandSet { type: SetType; start: number; }  // start = lowest 34-index

export interface Decomposition {
  sets: HandSet[];   // the melds formed from concealed tiles (excludes declared melds)
  pair: number;      // 34-index of the pair
}

/** All ways to split the concealed counts (which must total 3*setsNeeded + 2) into
 *  `setsNeeded` sets + one pair. Returns [] if impossible. */
export function decompose(counts: number[], setsNeeded: number): Decomposition[] {
  const results: Decomposition[] = [];
  const c = counts.slice();
  for (let p = 0; p < 34; p++) {
    if (c[p] >= 2) {
      c[p] -= 2;
      for (const sets of extractSets(c, setsNeeded)) results.push({ sets, pair: p });
      c[p] += 2;
    }
  }
  return results;
}

/** All ways to extract exactly `need` sets (seq/triplet) from counts. */
function extractSets(c: number[], need: number): HandSet[][] {
  if (need === 0) return c.every((x) => x === 0) ? [[]] : [];
  let i = 0;
  while (i < 34 && c[i] === 0) i++;
  if (i === 34) return [];
  const out: HandSet[][] = [];

  // triplet at i
  if (c[i] >= 3) {
    c[i] -= 3;
    for (const rest of extractSets(c, need - 1)) out.push([{ type: 'triplet', start: i }, ...rest]);
    c[i] += 3;
  }
  // sequence starting at i
  if (canSequence(i) && c[i + 1] > 0 && c[i + 2] > 0) {
    c[i]--; c[i + 1]--; c[i + 2]--;
    for (const rest of extractSets(c, need - 1)) out.push([{ type: 'seq', start: i }, ...rest]);
    c[i]++; c[i + 1]++; c[i + 2]++;
  }
  return out;
}

/** Seven pairs (chiitoitsu): exactly 7 distinct pairs, concealed 14 tiles. */
export function isChiitoitsu(counts: number[]): boolean {
  let pairs = 0;
  for (const x of counts) { if (x === 2) pairs++; else if (x !== 0) return false; }
  return pairs === 7;
}

const KOKUSHI = [0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33];
/** Thirteen orphans (kokushi musou), concealed 14 tiles. Returns {ok, thirteenWait}. */
export function kokushiInfo(counts: number[]): { ok: boolean; thirteenWait: boolean } {
  let total = 0, hasPair = false;
  for (let i = 0; i < 34; i++) {
    if (!KOKUSHI.includes(i)) { if (counts[i] > 0) return { ok: false, thirteenWait: false }; continue; }
    if (counts[i] === 0) return { ok: false, thirteenWait: false };
    if (counts[i] === 2) hasPair = true;
    if (counts[i] > 2) return { ok: false, thirteenWait: false };
    total += counts[i];
  }
  return { ok: total === 14 && hasPair, thirteenWait: false };
}

/** Is a 14-tile concealed hand (no melds) a complete winning shape? */
export function isCompleteConcealed(counts: number[]): boolean {
  if (isChiitoitsu(counts)) return true;
  if (kokushiInfo(counts).ok) return true;
  return decompose(counts, 4).length > 0;
}

/** Is a hand (concealed counts, with `meldCount` declared melds) complete? */
export function isComplete(counts: number[], meldCount: number): boolean {
  const setsNeeded = 4 - meldCount;
  if (meldCount === 0) {
    if (isChiitoitsu(counts) || kokushiInfo(counts).ok) return true;
  }
  return decompose(counts, setsNeeded).length > 0;
}

/** Waiting tiles (34-indices) for a tenpai hand; empty if not tenpai. */
export function waits(counts: number[], meldCount: number): number[] {
  const w: number[] = [];
  for (let t = 0; t < 34; t++) {
    if (counts[t] >= 4) continue;
    counts[t]++;
    if (isComplete(counts, meldCount)) w.push(t);
    counts[t]--;
  }
  return w;
}

export function isTenpai(counts: number[], meldCount: number): boolean {
  return waits(counts, meldCount).length > 0;
}
