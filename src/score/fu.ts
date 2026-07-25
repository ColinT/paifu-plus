/** Fu (符) calculation for a finalized hand. */

import { isTerminalOrHonor } from './hand.js';
import type { FullSet, WaitType, WinContext } from './types.js';

const DRAGONS = [31, 32, 33];

export function isPinfuShape(sets: FullSet[], pair: number, wait: WaitType, ctx: WinContext, menzen: boolean): boolean {
  if (!menzen) return false;
  if (!sets.every((s) => s.type === 'seq')) return false;
  if (wait !== 'ryanmen') return false;
  if (DRAGONS.includes(pair) || pair === ctx.roundWind || pair === ctx.seatWind) return false;
  return true;
}

export function calcFu(sets: FullSet[], pair: number, wait: WaitType, ctx: WinContext, menzen: boolean): number {
  if (isPinfuShape(sets, pair, wait, ctx, menzen)) return ctx.isTsumo ? 20 : 30;

  let fu = 20;
  if (wait === 'kanchan' || wait === 'penchan' || wait === 'tanki') fu += 2;
  if (DRAGONS.includes(pair)) fu += 2;
  if (pair === ctx.roundWind) fu += 2;
  if (pair === ctx.seatWind) fu += 2;

  for (const s of sets) {
    if (s.type === 'seq') continue;
    const term = isTerminalOrHonor(s.start);
    if (s.type === 'kan') fu += s.open ? (term ? 16 : 8) : (term ? 32 : 16);
    else fu += s.open ? (term ? 4 : 2) : (term ? 8 : 4);
  }

  if (ctx.isTsumo) fu += 2;
  else if (menzen) fu += 10; // menzen ron

  fu = Math.ceil(fu / 10) * 10;
  if (!ctx.isTsumo && fu === 20) fu = 30; // open ron minimum (kuipinfu shape)
  return fu;
}
