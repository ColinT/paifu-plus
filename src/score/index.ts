/** Top-level scoring: winning-hand value and ryuukyoku payments. */

import { counts, toIndex, akaCount, doraFromIndicator, canSequence } from './hand.js';
import { decompose, isChiitoitsu, kokushiInfo } from './decompose.js';
import { detectYaku } from './yaku.js';
import { calcFu } from './fu.js';
import { limitBase, scoreString } from './score.js';
import type { FullSet, WaitType, WinContext, ScoreResult, YakuLine } from './types.js';
import type { TenhouTile } from '../core/tiles.js';

export { agariDeltas, ryuukyokuDeltas, limitBase } from './score.js';
export * from './types.js';
export { isTenpai, waits } from './decompose.js';
export { counts, toIndex } from './hand.js';

function meldToSet(m: { type: string; tiles: TenhouTile[] }): FullSet {
  const idxs = m.tiles.map(toIndex).sort((a, b) => a - b);
  const start = idxs[0];
  if (m.type === 'chi') return { type: 'seq', start, open: true };
  if (m.type === 'ankan') return { type: 'kan', start, open: false, kanClosed: true };
  if (m.type === 'daiminkan' || m.type === 'kakan' || m.type === 'minkan') return { type: 'kan', start, open: true };
  return { type: 'triplet', start, open: true }; // pon
}

function doraHanFor(indicators: TenhouTile[], all34: number[]): number {
  let han = 0;
  for (const ind of indicators) { const d = doraFromIndicator(ind); han += all34.filter((t) => t === d).length; }
  return han;
}

export function scoreWin(ctx: WinContext): ScoreResult {
  const concealedTiles = [...ctx.concealed, ctx.winningTile];
  const meldTiles = ctx.melds.flatMap((m) => m.tiles);
  const all34 = [...concealedTiles, ...meldTiles].map(toIndex);
  const cCounts = counts(concealedTiles);
  const meldCount = ctx.melds.length;
  const menzen = ctx.melds.every((m) => m.type === 'ankan');
  const dealer = ctx.seatWind === 27; // dealer's seat wind is East (27)
  const wt = toIndex(ctx.winningTile);

  const dora = doraHanFor(ctx.doraIndicators, all34)
    + akaCount(concealedTiles) + akaCount(meldTiles)
    + (ctx.riichi ? doraHanFor(ctx.uraIndicators, all34) : 0);
  const doraLines = (n: number): YakuLine[] => n > 0 ? [{ name: 'ドラ', han: n }] : [];

  const meldSets = ctx.melds.map(meldToSet);

  // ----- special hands (concealed only) -----
  if (meldCount === 0) {
    const kok = kokushiInfo(cCounts);
    if (kok.ok) return finalizeYakuman([{ name: '国士無双', han: 13 }], 1);
    if (isChiitoitsu(cCounts)) {
      const base = { lines: [{ name: '七対子', han: 2 }] as YakuLine[] };
      if (ctx.riichi) base.lines.unshift({ name: ctx.doubleRiichi ? 'ダブル立直' : '立直', han: ctx.doubleRiichi ? 2 : 1 });
      if (ctx.ippatsu) base.lines.push({ name: '一発', han: 1 });
      if (menzen && ctx.isTsumo) base.lines.push({ name: '門前清自摸和', han: 1 });
      const tiles34 = concealedTiles.map(toIndex);
      if (tiles34.every((t) => t < 27 && t % 9 !== 0 && t % 9 !== 8)) base.lines.push({ name: '断幺九', han: 1 });
      const suitset = new Set(tiles34.filter((t) => t < 27).map((t) => Math.floor(t / 9)));
      const hasHonor = tiles34.some((t) => t >= 27);
      if (suitset.size === 1) base.lines.push({ name: hasHonor ? '混一色' : '清一色', han: hasHonor ? 3 : 6 });
      return finalizeStandard(base.lines, 25, dora, doraLines(dora));
    }
  }

  // ----- standard decompositions -----
  let best: ScoreResult | null = null;
  const decomps = decompose(cCounts, 4 - meldCount);
  for (const d of decomps) {
    for (const place of placements(d.sets.map((s) => ({ type: s.type as FullSet['type'], start: s.start, open: false })), d.pair, wt, ctx.isTsumo)) {
      const full: FullSet[] = [...place.sets, ...meldSets];
      const parsed = { sets: full, pair: d.pair, waitType: place.wait, winningTile: wt };
      const { lines, yakuman } = detectYaku(parsed, ctx, menzen);
      let res: ScoreResult;
      if (yakuman > 0) res = finalizeYakuman(lines, yakuman);
      else {
        const baseHan = lines.reduce((s, l) => s + l.han, 0);
        if (baseHan === 0) continue; // no yaku
        const fu = calcFu(full, d.pair, place.wait, ctx, menzen);
        res = finalizeStandard(lines, fu, dora, doraLines(dora));
      }
      if (!best || res.base > best.base || (res.base === best.base && res.han > best.han)) best = res;
    }
  }
  return best ?? { valid: false, yaku: [], yakuman: 0, han: 0, fu: 0, base: 0, limitName: null, text: 'no yaku' };

  function finalizeYakuman(lines: YakuLine[], yakuman: number): ScoreResult {
    const { base, name } = limitBase(0, 0, yakuman, ctx.rules);
    const text = scoreString(base, 0, 0, name ?? '役満', dealer, ctx.isTsumo);
    return { valid: true, yaku: lines, yakuman, han: 0, fu: 0, base, limitName: name, text };
  }
  function finalizeStandard(lines: YakuLine[], fu: number, doraN: number, dLines: YakuLine[]): ScoreResult {
    const han = lines.reduce((s, l) => s + l.han, 0) + doraN;
    const { base, name } = limitBase(han, fu, 0, ctx.rules);
    const text = scoreString(base, fu, han, name, dealer, ctx.isTsumo);
    return { valid: true, yaku: [...lines, ...dLines], yakuman: 0, han, fu, base, limitName: name, text };
  }
}

interface Placement { sets: FullSet[]; wait: WaitType; }

/** Enumerate which concealed set the winning tile completes, and the wait type. */
function placements(sets: FullSet[], pair: number, wt: number, isTsumo: boolean): Placement[] {
  const out: Placement[] = [];
  // tanki: winning tile is the pair
  if (pair === wt) out.push({ sets: sets.slice(), wait: 'tanki' });
  sets.forEach((s, i) => {
    if (s.type === 'seq') {
      const inSeq = wt >= s.start && wt <= s.start + 2 && canSequence(s.start);
      if (!inSeq) return;
      let wait: WaitType;
      const rank = (wt % 9) + 1;
      if (wt === s.start + 1) wait = 'kanchan';
      else if (wt === s.start && rank === 7) wait = 'penchan';
      else if (wt === s.start + 2 && rank === 3) wait = 'penchan';
      else wait = 'ryanmen';
      out.push({ sets: sets.slice(), wait });
    } else if (s.start === wt) {
      // shanpon: winning tile completes this triplet; ron ⇒ minko (open)
      const copy = sets.map((x, j) => (j === i ? { ...x, open: !isTsumo } : x));
      out.push({ sets: copy, wait: 'shanpon' });
    }
  });
  if (out.length === 0) out.push({ sets: sets.slice(), wait: 'tanki' }); // fallback
  return out;
}
