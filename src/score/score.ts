/** Han/fu → points, limit hands, and per-seat delta construction. */

import type { Rules } from './types.js';

export interface Limit { base: number; name: string | null; }

/** Base points `a` (payments are multiples of this), plus any limit name. */
export function limitBase(han: number, fu: number, yakuman: number, rules: Rules): Limit {
  if (yakuman > 0) return { base: 8000 * yakuman, name: yakuman === 1 ? '役満' : `${yakuman}倍役満` };
  if (han >= 13) return { base: 8000, name: '数え役満' };
  if (han >= 11) return { base: 6000, name: '三倍満' };
  if (han >= 8) return { base: 4000, name: '倍満' };
  if (han >= 6) return { base: 3000, name: '跳満' };
  if (han >= 5) return { base: 2000, name: '満貫' };
  const base = fu * Math.pow(2, 2 + han);
  if (rules.kiriageMangan && ((han === 4 && fu === 30) || (han === 3 && fu === 60))) return { base: 2000, name: '満貫' };
  if (base >= 2000) return { base: 2000, name: '満貫' }; // 3han70+/4han40+ cap
  return { base, name: null };
}

const roundUp = (n: number) => Math.ceil(n / 100) * 100;

/** tenhou-style score string, e.g. "30符3飜3900点", "満貫8000点",
 *  "20符4飜1300-2600点" (non-dealer tsumo), "跳満6000点∀" (dealer tsumo). */
export function scoreString(base: number, fu: number, han: number, limitName: string | null, isDealer: boolean, isTsumo: boolean): string {
  const prefix = limitName ?? `${fu}符${han}飜`;
  if (isTsumo) {
    if (isDealer) return `${prefix}${roundUp(base * 2)}点∀`;
    return `${prefix}${roundUp(base)}-${roundUp(base * 2)}点`;
  }
  return `${prefix}${roundUp(base * (isDealer ? 6 : 4))}点`;
}

export interface AgariPayments {
  /** per-seat deltas (indexed 0..3). */
  deltas: number[];
  winnerGain: number;
}

/**
 * Build per-seat deltas for a win. winner/from/dealerSeat are indices into the
 * 4-array; from === winner ⇒ tsumo. Honba adds 300 (ron) / 100 each (tsumo);
 * the winner also collects `sticks`×1000 riichi deposits.
 */
export function agariDeltas(opts: {
  winner: number; from: number; dealerSeat: number; isTsumo: boolean;
  base: number; honba: number; sticks: number;
}): AgariPayments {
  const { winner, from, dealerSeat, isTsumo, base, honba, sticks } = opts;
  const isDealer = winner === dealerSeat;
  const deltas = [0, 0, 0, 0];
  let gain = 0;

  if (isTsumo) {
    if (isDealer) {
      const each = roundUp(base * 2) + honba * 100;
      for (let s = 0; s < 4; s++) if (s !== winner) { deltas[s] -= each; gain += each; }
    } else {
      const nonDealerPay = roundUp(base) + honba * 100;
      const dealerPay = roundUp(base * 2) + honba * 100;
      for (let s = 0; s < 4; s++) {
        if (s === winner) continue;
        const pay = s === dealerSeat ? dealerPay : nonDealerPay;
        deltas[s] -= pay; gain += pay;
      }
    }
  } else {
    const total = roundUp(base * (isDealer ? 6 : 4)) + honba * 300;
    deltas[from] -= total; gain += total;
  }
  gain += sticks * 1000;
  deltas[winner] += gain;
  return { deltas, winnerGain: gain };
}

/** Ryuukyoku noten payments: 3000 total exchanged between tenpai and noten. */
export function ryuukyokuDeltas(tenpai: boolean[]): number[] {
  const t = tenpai.filter(Boolean).length;
  const deltas = [0, 0, 0, 0];
  if (t === 0 || t === 4) return deltas;
  const recv = 3000 / t, pay = 3000 / (4 - t);
  for (let s = 0; s < 4; s++) deltas[s] = tenpai[s] ? recv : -pay;
  return deltas;
}
