import { describe, it, expect } from 'vitest';
import { kyokuToBoardView } from '../src/ui/board.js';
import type { Kyoku, PlayerHand, Seat, Turn, Call } from '../src/core/model.js';

// Tile codes: manzu 1-9m = 11..19, pinzu = 21..29, souzu = 31..39.
const M = (r: number) => 10 + r;

function player(over: Partial<PlayerHand>): PlayerHand {
  return { seat: 0, name: 'A', startScore: 25000, scoreDelta: 0, haipai: [], turns: [], calls: [], ...over };
}
function kyoku(dealer: PlayerHand): Kyoku {
  const rest = [1, 2, 3].map((s) => player({ seat: s as Seat, name: `P${s}` }));
  return {
    round: 0, honba: 0, riichiSticks: 0, doraIndicators: [], uraIndicators: [],
    players: [dealer, ...rest] as Kyoku['players'], result: { kind: 'ryuukyoku', deltas: [0, 0, 0, 0] },
  };
}
// A chi of 5m using the hand's 4m + 6m; the 5m was CALLED from an opponent.
const chi5m: Call = { type: 'chi', tiles: [M(5), M(4), M(6)], calledTile: M(5), fromSeat: 3 as Seat, turn: 0 };

describe('kyokuToBoardView hand reconstruction', () => {
  it("keeps a concealed tile whose value was earlier called for a chi", () => {
    // Haipai holds a concealed 5m plus the 4m/6m spent on the chi; last turn is
    // complete (a tsumogiri), so nothing is held apart.
    const last: Turn = { draw: M(7), discard: M(7), tsumogiri: true };
    const p = player({ haipai: [M(5), M(4), M(6), M(1), M(2), M(3), M(8), M(9), 21, 22, 23, 24, 25], turns: [last], calls: [chi5m] });
    const s = kyokuToBoardView(kyoku(p)).seats[0];
    expect(s.hand.includes(M(5))).toBe(true);   // the called tile must not evict the concealed 5m
    expect(s.hand.includes(M(4))).toBe(false);  // the 4m/6m that formed the meld are gone
    expect(s.hand.includes(M(6))).toBe(false);
  });

  it('holds a just-drawn tile apart even when its value was earlier called', () => {
    // Dealer chi'd a 5m, then draws another 5m and hasn't discarded → held apart.
    const p = player({ haipai: [M(4), M(6), M(1), M(2), M(3), M(7), M(8), M(9), 21, 22, 23, 31, 32], turns: [{ draw: M(5) }], calls: [chi5m] });
    const s = kyokuToBoardView(kyoku(p)).seats[0];
    expect(s.drawn).toBe(M(5));                  // the fresh 5m is the drawn tile, not dropped
    expect(s.hand.includes(M(5))).toBe(false);   // and not duplicated in the concealed hand
  });
});
