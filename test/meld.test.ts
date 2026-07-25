import { describe, it, expect } from 'vitest';
import { meldString } from '../src/core/tenhou.js';
import type { Call, Seat } from '../src/core/model.js';

describe('tenhou meld strings', () => {
  const pon = (called: number, from: Seat): Call => ({ type: 'pon', tiles: [called, called, called], calledTile: called, fromSeat: from, turn: 0 });

  it('pon keeps all three tiles (bug: filter dropped identical copies)', () => {
    // West (2) pons 3z(43) off North (3, its shimocha) → called tile last.
    expect(meldString(pon(43, 3), 2)).toBe('4343p43');
    // pon off kamicha → called tile first.
    expect(meldString(pon(45, 3), 0)).toBe('p454545');
    // every pon string has exactly three tile numbers
    const s = meldString(pon(11, 2), 0);
    expect((s.match(/\d\d/g) || []).length).toBe(3);
  });

  it('chi lists the called tile first after c', () => {
    const chi: Call = { type: 'chi', tiles: [21, 22, 23], calledTile: 22, fromSeat: 1, turn: 0 };
    expect(meldString(chi, 2)).toBe('c222123');
  });

  it('ankan is four tiles with a before the last', () => {
    const ankan: Call = { type: 'ankan', tiles: [25, 25, 25, 25], turn: 0 };
    expect(meldString(ankan, 0)).toBe('252525a25');
  });
});
