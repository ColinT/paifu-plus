/**
 * Cross-round state for a multi-round game.
 *
 * The editor transcribes one round at a time, so a round's DSL needn't restate
 * the running scores, honba, or riichi deposits it inherits from the round
 * before it. This fills those in from the previous round — but only where the
 * round left them at their defaults, so anything explicit in the DSL (a typed
 * starting score, an `e1.2.3` honba/stick round token) is preserved. When an
 * explicit value contradicts what the previous round implies, it's reported as
 * a conflict for the UI to surface rather than being silently changed.
 */

import type { Game, Kyoku } from '../core/model.js';

export interface CarryConflict {
  /** Index of the kyoku whose explicit value contradicts the previous round. */
  kyoku: number;
  field: 'scores' | 'honba' | 'deposits';
  message: string;
}

/** Seats that declared riichi in a kyoku (each puts a 1000-point stick in). */
function riichiCount(k: Kyoku): number {
  return k.players.filter((p) => p.turns.some((t) => t.riichi)).length;
}

/** Ending scores of a round, per seat = starting score + this round's delta. */
function endScores(k: Kyoku): number[] {
  return k.players.map((p) => p.startScore + p.scoreDelta);
}

/**
 * Fill each round's inherited state from the one before it, in place. Returns
 * the conflicts found where a round stated a value that disagrees with the
 * previous round's outcome.
 *
 * - **scores**: filled with the previous round's ending scores when the round
 *   left every seat at the 25000 default.
 * - **honba**: previous + 1, but 0 after a non-dealer win. Filled only when 0.
 * - **deposits** (the pot carried into the round): the previous pot plus that
 *   round's riichi sticks on a draw, else 0 (a winner claims the pot). Filled
 *   only when 0.
 */
export function applyCarryOver(game: Game): CarryConflict[] {
  const conflicts: CarryConflict[] = [];
  for (let i = 1; i < game.kyokus.length; i++) {
    const prev = game.kyokus[i - 1];
    const cur = game.kyokus[i];

    // Running scores.
    const expectScores = endScores(prev);
    if (cur.players.every((p) => p.startScore === 25000)) {
      for (let s = 0; s < 4; s++) cur.players[s].startScore = expectScores[s];
    } else if (cur.players.some((p, s) => p.startScore !== expectScores[s])) {
      conflicts.push({ kyoku: i, field: 'scores', message: `starting scores don't match the previous round's result (expected ${expectScores.join('/')}, got ${cur.players.map((p) => p.startScore).join('/')})` });
    }

    // Honba.
    const dealer = prev.round % 4;
    const nonDealerWin = (prev.result.kind === 'ron' || prev.result.kind === 'tsumo')
      && prev.result.winner !== undefined && prev.result.winner !== dealer;
    const expectHonba = nonDealerWin ? 0 : prev.honba + 1;
    if (cur.honba === 0) cur.honba = expectHonba;
    else if (cur.honba !== expectHonba) {
      conflicts.push({ kyoku: i, field: 'honba', message: `honba ${cur.honba} doesn't match the ${expectHonba} expected after the previous round` });
    }

    // Riichi deposits (the pot on the table at the start of the round).
    const expectPot = prev.result.kind === 'ryuukyoku' ? prev.riichiSticks + riichiCount(prev) : 0;
    if (cur.riichiSticks === 0) cur.riichiSticks = expectPot;
    else if (cur.riichiSticks !== expectPot) {
      conflicts.push({ kyoku: i, field: 'deposits', message: `riichi deposits ${cur.riichiSticks} don't match the ${expectPot} expected after the previous round` });
    }
  }
  return conflicts;
}
