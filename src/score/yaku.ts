/** Yaku detection over a finalized 4-sets-plus-pair hand. */

import { isHonor, isTerminal, isTerminalOrHonor, suitOf, rankOf, HONOR } from './hand.js';
import type { FullSet, WaitType, WinContext, YakuLine } from './types.js';

interface Parsed {
  sets: FullSet[];   // exactly 4
  pair: number;
  waitType: WaitType;
  winningTile: number; // 34-index
}

const DRAGONS = [31, 32, 33]; // haku, hatsu, chun (34-index)

/** All 34-index tiles present in the hand (sets expanded + pair), for suit/tanyao checks. */
function allTiles(p: Parsed): number[] {
  const out: number[] = [p.pair, p.pair];
  for (const s of p.sets) {
    if (s.type === 'seq') out.push(s.start, s.start + 1, s.start + 2);
    else { const n = s.type === 'kan' ? 4 : 3; for (let i = 0; i < n; i++) out.push(s.start); }
  }
  return out;
}

/** Detect standard yaku (excluding dora, which is added separately). Returns [] if no yaku. */
export function detectYaku(p: Parsed, ctx: WinContext, menzen: boolean): { lines: YakuLine[]; yakuman: number } {
  const lines: YakuLine[] = [];
  let yakuman = 0;
  const seqs = p.sets.filter((s) => s.type === 'seq');
  const trips = p.sets.filter((s) => s.type !== 'seq');
  const tiles = allTiles(p);
  const open = ctx.melds.length > 0;

  // ---------- yakuman ----------
  // suuankou: 4 concealed triplets
  const concealedTrips = trips.filter((s) => !s.open);
  if (trips.length === 4 && concealedTrips.length === 4) { yakuman++; lines.push({ name: '四暗刻', han: 13 }); }
  // daisangen / shousangen
  const dragonTrips = trips.filter((s) => DRAGONS.includes(s.start)).length;
  if (dragonTrips === 3) { yakuman++; lines.push({ name: '大三元', han: 13 }); }
  // suushii
  const windTrips = trips.filter((s) => s.start >= 27 && s.start <= 30).length;
  const windPair = p.pair >= 27 && p.pair <= 30;
  if (windTrips === 4) { yakuman++; lines.push({ name: '大四喜', han: 13 }); }
  else if (windTrips === 3 && windPair) { yakuman++; lines.push({ name: '小四喜', han: 13 }); }
  // tsuuiisou: all honors
  if (tiles.every(isHonor)) { yakuman++; lines.push({ name: '字一色', han: 13 }); }
  // chinroutou: all terminals
  if (tiles.every((t) => !isHonor(t) && isTerminal(t))) { yakuman++; lines.push({ name: '清老頭', han: 13 }); }
  // ryuuiisou: all green (2,3,4,6,8 sou + hatsu)
  const GREEN = new Set([19, 20, 21, 23, 25, 32]);
  if (tiles.every((t) => GREEN.has(t))) { yakuman++; lines.push({ name: '緑一色', han: 13 }); }
  // chuuren poutou: pure nine gates (concealed, one suit 1112345678999 + any)
  if (menzen && isChuuren(p, tiles)) { yakuman++; lines.push({ name: '九蓮宝燈', han: 13 }); }
  // suukantsu
  if (p.sets.filter((s) => s.type === 'kan').length === 4) { yakuman++; lines.push({ name: '四槓子', han: 13 }); }
  // kokushi handled elsewhere.
  if (yakuman > 0) return { lines, yakuman };

  // ---------- 1 han ----------
  if (ctx.riichi && !ctx.doubleRiichi) lines.push({ name: '立直', han: 1 });
  if (ctx.doubleRiichi) lines.push({ name: 'ダブル立直', han: 2 });
  if (ctx.ippatsu) lines.push({ name: '一発', han: 1 });
  if (menzen && ctx.isTsumo) lines.push({ name: '門前清自摸和', han: 1 });
  if (ctx.haitei) lines.push({ name: ctx.isTsumo ? '海底摸月' : '河底撈魚', han: 1 });
  if (ctx.houtei && !ctx.isTsumo) lines.push({ name: '河底撈魚', han: 1 });
  if (ctx.rinshan) lines.push({ name: '嶺上開花', han: 1 });
  if (ctx.chankan) lines.push({ name: '槍槓', han: 1 });

  // tanyao
  if (tiles.every((t) => !isTerminalOrHonor(t))) {
    if (!open || ctx.rules.kuitan !== false) lines.push({ name: '断幺九', han: 1 });
  }
  // yakuhai
  for (const s of trips) {
    if (DRAGONS.includes(s.start)) lines.push({ name: '役牌', han: 1 });
    else if (s.start === ctx.roundWind) lines.push({ name: '場風', han: 1 });
    if (s.start === ctx.seatWind && s.start >= 27) { if (s.start !== ctx.roundWind || true) lines.push({ name: '自風', han: 1 }); }
  }
  // pinfu
  if (menzen && seqs.length === 4 && p.waitType === 'ryanmen') {
    const pairYakuhai = DRAGONS.includes(p.pair) || p.pair === ctx.roundWind || p.pair === ctx.seatWind;
    if (!pairYakuhai) lines.push({ name: '平和', han: 1 });
  }
  // iipeikou / ryanpeikou (menzen)
  const seqCounts = new Map<number, number>();
  for (const s of seqs) seqCounts.set(s.start, (seqCounts.get(s.start) ?? 0) + 1);
  const pairsOfSeq = [...seqCounts.values()].filter((n) => n >= 2).length;
  if (menzen) {
    if (pairsOfSeq === 2) lines.push({ name: '二盃口', han: 3 });
    else if (pairsOfSeq === 1) lines.push({ name: '一盃口', han: 1 });
  }

  // ---------- 2 han (kuisagari where noted) ----------
  // sanshoku doujun
  if (hasSanshokuSeq(seqs)) lines.push({ name: '三色同順', han: open ? 1 : 2 });
  // sanshoku doukou
  if (hasSanshokuTriplet(trips)) lines.push({ name: '三色同刻', han: 2 });
  // ittsuu
  if (hasIttsuu(seqs)) lines.push({ name: '一気通貫', han: open ? 1 : 2 });
  // toitoi
  if (trips.length === 4) lines.push({ name: '対々和', han: 2 });
  // sanankou
  const ankouCount = trips.filter((s) => !s.open).length;
  if (ankouCount === 3) lines.push({ name: '三暗刻', han: 2 });
  // sankantsu
  if (p.sets.filter((s) => s.type === 'kan').length === 3) lines.push({ name: '三槓子', han: 2 });
  // shousangen
  if (dragonTrips === 2 && DRAGONS.includes(p.pair)) lines.push({ name: '小三元', han: 2 });
  // honroutou
  if (tiles.every(isTerminalOrHonor) && trips.length === 4) lines.push({ name: '混老頭', han: 2 });
  // chanta / junchan
  const setsAndPair: number[][] = [[p.pair]];
  for (const s of p.sets) setsAndPair.push(s.type === 'seq' ? [s.start, s.start + 1, s.start + 2] : [s.start]);
  const everyHasTermOrHonor = setsAndPair.every((g) => g.some(isTerminalOrHonor));
  const anyHonor = tiles.some(isHonor);
  const anySeq = seqs.length > 0;
  if (everyHasTermOrHonor && anySeq && !tiles.every(isTerminalOrHonor)) {
    if (anyHonor) lines.push({ name: '混全帯幺九', han: open ? 1 : 2 });
    else lines.push({ name: '純全帯幺九', han: open ? 2 : 3 });
  }

  // ---------- 3 han (kuisagari) ----------
  const suits = new Set(tiles.filter((t) => t < HONOR).map(suitOf));
  const hasHonor = tiles.some(isHonor);
  if (suits.size === 1) {
    if (!hasHonor) lines.push({ name: '清一色', han: open ? 5 : 6 });
    else lines.push({ name: '混一色', han: open ? 2 : 3 });
  }

  return { lines, yakuman: 0 };
}

function hasSanshokuSeq(seqs: FullSet[]): boolean {
  for (const s of seqs) {
    if (s.start >= HONOR) continue;
    const rank = s.start % 9;
    const suitsWith = new Set(seqs.filter((x) => x.start % 9 === rank && x.start < HONOR).map((x) => suitOf(x.start)));
    if (suitsWith.size === 3) return true;
  }
  return false;
}
function hasSanshokuTriplet(trips: FullSet[]): boolean {
  for (const s of trips) {
    if (s.start >= HONOR) continue;
    const rank = s.start % 9;
    const suitsWith = new Set(trips.filter((x) => x.start < HONOR && x.start % 9 === rank).map((x) => suitOf(x.start)));
    if (suitsWith.size === 3) return true;
  }
  return false;
}
function hasIttsuu(seqs: FullSet[]): boolean {
  for (let suit = 0; suit < 3; suit++) {
    const starts = new Set(seqs.filter((s) => suitOf(s.start) === suit).map((s) => s.start % 9));
    if (starts.has(0) && starts.has(3) && starts.has(6)) return true;
  }
  return false;
}
function isChuuren(p: Parsed, tiles: number[]): boolean {
  const suits = new Set(tiles.map((t) => (t < HONOR ? suitOf(t) : 3)));
  if (suits.size !== 1 || tiles.some(isHonor)) return false;
  const suit = suitOf(tiles[0]);
  const c = new Array(9).fill(0);
  for (const t of tiles) c[t - suit * 9]++;
  // needs 3x terminal each end, 1x of 2..8, plus one extra
  const need = [3, 1, 1, 1, 1, 1, 1, 1, 3];
  for (let i = 0; i < 9; i++) if (c[i] < need[i]) return false;
  void p; void rankOf;
  return true;
}
