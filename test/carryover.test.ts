import { describe, it, expect } from 'vitest';
import { applyCarryOver } from '../src/stream/carryover.js';
import type { Game, Kyoku, PlayerHand, Seat, KyokuResult } from '../src/core/model.js';

function player(seat: Seat, startScore: number, scoreDelta = 0, riichi = false): PlayerHand {
  return { seat, name: `P${seat}`, startScore, scoreDelta, haipai: [], turns: riichi ? [{ riichi: true }] : [], calls: [] };
}
function kyoku(round: number, honba: number, sticks: number, players: PlayerHand[], result: KyokuResult): Kyoku {
  return { round, honba, riichiSticks: sticks, doraIndicators: [], uraIndicators: [], players: players as Kyoku['players'], result };
}
function game(kyokus: Kyoku[]): Game {
  return { meta: { title: [''], names: ['', '', '', ''], rule: {} }, kyokus };
}
const four = (scores: number[], deltas: number[] = [0, 0, 0, 0], riichi: boolean[] = []) =>
  scores.map((s, i) => player(i as Seat, s, deltas[i], riichi[i])) as PlayerHand[];

describe('carry-over: fill when unspecified', () => {
  it('fills a round\'s starting scores from the previous round\'s result', () => {
    const g = game([
      kyoku(0, 0, 0, four([25000, 25000, 25000, 25000], [6000, -2000, -2000, -2000]), { kind: 'tsumo', winner: 0, deltas: [6000, -2000, -2000, -2000] }),
      kyoku(1, 0, 0, four([25000, 25000, 25000, 25000]), { kind: 'ryuukyoku', deltas: [0, 0, 0, 0] }),
    ]);
    const conflicts = applyCarryOver(g);
    expect(g.kyokus[1].players.map((p) => p.startScore)).toEqual([31000, 23000, 23000, 23000]);
    expect(conflicts).toEqual([]);
  });

  it('honba: +1 after a draw, +1 after a dealer win, 0 after a non-dealer win', () => {
    const draw = game([
      kyoku(0, 1, 0, four([25000, 25000, 25000, 25000]), { kind: 'ryuukyoku', deltas: [0, 0, 0, 0] }),
      kyoku(1, 0, 0, four([25000, 25000, 25000, 25000]), { kind: 'ryuukyoku', deltas: [0, 0, 0, 0] }),
    ]);
    applyCarryOver(draw);
    expect(draw.kyokus[1].honba).toBe(2);

    const dealerWin = game([
      kyoku(0, 2, 0, four([25000, 25000, 25000, 25000]), { kind: 'tsumo', winner: 0, deltas: [0, 0, 0, 0] }),
      kyoku(1, 0, 0, four([25000, 25000, 25000, 25000]), { kind: 'ryuukyoku', deltas: [0, 0, 0, 0] }),
    ]);
    applyCarryOver(dealerWin);
    expect(dealerWin.kyokus[1].honba).toBe(3);

    const nonDealerWin = game([
      kyoku(0, 3, 0, four([25000, 25000, 25000, 25000]), { kind: 'ron', winner: 1, loser: 0, deltas: [0, 0, 0, 0] }),
      kyoku(1, 0, 0, four([25000, 25000, 25000, 25000]), { kind: 'ryuukyoku', deltas: [0, 0, 0, 0] }),
    ]);
    applyCarryOver(nonDealerWin);
    expect(nonDealerWin.kyokus[1].honba).toBe(0);
  });

  it('deposits: the pot (start + this round\'s riichi sticks) carries on a draw, clears on a win', () => {
    const draw = game([
      kyoku(0, 0, 1, four([25000, 24000, 25000, 25000], [0, -1000, 0, 0], [false, true, false, false]), { kind: 'ryuukyoku', deltas: [0, -1000, 0, 0] }),
      kyoku(1, 0, 0, four([25000, 25000, 25000, 25000]), { kind: 'ryuukyoku', deltas: [0, 0, 0, 0] }),
    ]);
    applyCarryOver(draw);
    expect(draw.kyokus[1].riichiSticks).toBe(2); // 1 carried + 1 new riichi

    const win = game([
      kyoku(0, 0, 2, four([25000, 25000, 25000, 25000]), { kind: 'ron', winner: 2, loser: 0, deltas: [0, 0, 0, 0] }),
      kyoku(1, 0, 0, four([25000, 25000, 25000, 25000]), { kind: 'ryuukyoku', deltas: [0, 0, 0, 0] }),
    ]);
    applyCarryOver(win);
    expect(win.kyokus[1].riichiSticks).toBe(0);
  });
});

describe('carry-over: preserve explicit values, report conflicts', () => {
  it('keeps an explicit starting score but flags the mismatch', () => {
    const g = game([
      kyoku(0, 0, 0, four([25000, 25000, 25000, 25000], [6000, -2000, -2000, -2000]), { kind: 'tsumo', winner: 0, deltas: [6000, -2000, -2000, -2000] }),
      kyoku(1, 0, 0, four([30000, 20000, 25000, 25000]), { kind: 'ryuukyoku', deltas: [0, 0, 0, 0] }),
    ]);
    const conflicts = applyCarryOver(g);
    expect(g.kyokus[1].players.map((p) => p.startScore)).toEqual([30000, 20000, 25000, 25000]); // unchanged
    expect(conflicts.map((c) => c.field)).toEqual(['scores']);
  });

  it('keeps an explicit honba but flags the mismatch', () => {
    const g = game([
      kyoku(0, 0, 0, four([25000, 25000, 25000, 25000]), { kind: 'ryuukyoku', deltas: [0, 0, 0, 0] }),
      kyoku(1, 5, 0, four([25000, 25000, 25000, 25000]), { kind: 'ryuukyoku', deltas: [0, 0, 0, 0] }),
    ]);
    const conflicts = applyCarryOver(g);
    expect(g.kyokus[1].honba).toBe(5);
    expect(conflicts.map((c) => c.field)).toEqual(['honba']);
  });
});
