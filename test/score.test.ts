import { describe, it, expect } from 'vitest';
import { scoreWin, agariDeltas, ryuukyokuDeltas, isTenpai, counts } from '../src/score/index.js';
import type { WinContext } from '../src/score/types.js';

const base = (over: Partial<WinContext>): WinContext => ({
  concealed: [], melds: [], winningTile: 11, isTsumo: false,
  seatWind: 28, roundWind: 27, doraIndicators: [], uraIndicators: [], rules: {}, ...over,
});
const names = (r: ReturnType<typeof scoreWin>) => r.yaku.map((y) => y.name);

describe('scoring: standard hands', () => {
  it('riichi + pinfu + menzen tsumo (3 han 20 fu)', () => {
    const r = scoreWin(base({
      concealed: [12, 13, 14, 24, 25, 26, 26, 27, 28, 32, 33, 19, 19], // 234m 456p 678p 23s 99m
      winningTile: 34, // 4s → 234s (ryanmen)
      isTsumo: true, riichi: true,
    }));
    expect(r.valid).toBe(true);
    expect(names(r)).toEqual(expect.arrayContaining(['立直', '平和', '門前清自摸和']));
    expect(r.han).toBe(3);
    expect(r.fu).toBe(20);
    expect(r.base).toBe(640);
  });

  it('tanyao only, open, ron (1 han)', () => {
    const r = scoreWin(base({
      concealed: [12, 13, 14, 15, 16, 17, 33, 34, 35, 24], // 234m 567m 345s 2p (10 concealed)
      melds: [{ type: 'pon', tiles: [23, 23, 23] }], // pon 3p
      winningTile: 24, // completes the 22p pair (tanki)
      isTsumo: false,
    }));
    expect(r.valid).toBe(true);
    expect(names(r)).toContain('断幺九');
  });

  it('counts dora and aka', () => {
    const r = scoreWin(base({
      concealed: [12, 13, 14, 24, 25, 26, 26, 27, 28, 32, 33, 19, 19],
      winningTile: 34, isTsumo: true, riichi: true,
      doraIndicators: [18], // indicator 8m → dora 9m; hand has two 9m
    }));
    expect(r.yaku.find((y) => y.name === 'ドラ')?.han).toBe(2);
    expect(r.han).toBe(5); // 3 + 2 dora → mangan
    expect(r.limitName).toBe('満貫');
  });

  it('chiitoitsu + riichi + tsumo (4 han 25 fu)', () => {
    const r = scoreWin(base({
      concealed: [11, 11, 13, 13, 25, 25, 27, 27, 39, 39, 42, 42, 44], // pairs + lone 4z
      winningTile: 44, isTsumo: true, riichi: true,
    }));
    expect(names(r)).toEqual(expect.arrayContaining(['立直', '七対子', '門前清自摸和']));
    expect(r.fu).toBe(25);
    expect(r.han).toBe(4);
    expect(r.base).toBe(1600);
  });

  it('kokushi musou = yakuman', () => {
    const r = scoreWin(base({
      concealed: [11, 19, 21, 29, 31, 39, 41, 42, 43, 44, 45, 46, 47],
      winningTile: 11, isTsumo: false,
    }));
    expect(r.yakuman).toBe(1);
    expect(names(r)).toContain('国士無双');
    expect(r.base).toBe(8000);
  });

  it('rejects a yaku-less open hand (dora alone is not a yaku)', () => {
    const r = scoreWin(base({
      concealed: [17, 18, 19, 21, 22, 23, 32, 33, 34, 27], // 789m 123p 234s 7p
      melds: [{ type: 'pon', tiles: [15, 15, 15] }],        // pon 5m (open ⇒ no menzen yaku)
      winningTile: 27,                                       // 77p pair (tanki); terminals ⇒ no tanyao
      isTsumo: false, doraIndicators: [11],                  // dora present but doesn't make a yaku
    }));
    expect(r.valid).toBe(false);
  });
});

describe('scoring: payments', () => {
  it('non-dealer tsumo 3han20fu (base 640): 700/700/1300', () => {
    const { deltas } = agariDeltas({ winner: 1, from: 1, dealerSeat: 0, isTsumo: true, base: 640, honba: 0, sticks: 0 });
    expect(deltas[0]).toBe(-1300); // dealer pays double
    expect(deltas[2]).toBe(-700);
    expect(deltas[3]).toBe(-700);
    expect(deltas[1]).toBe(2700);
  });

  it('dealer ron mangan (base 2000) + 1 honba + 1 stick', () => {
    const { deltas } = agariDeltas({ winner: 0, from: 2, dealerSeat: 0, isTsumo: false, base: 2000, honba: 1, sticks: 1 });
    expect(deltas[2]).toBe(-(12000 + 300)); // 2000*6 + 300 honba
    expect(deltas[0]).toBe(12000 + 300 + 1000);
  });

  it('ryuukyoku noten payments', () => {
    expect(ryuukyokuDeltas([true, false, false, false])).toEqual([3000, -1000, -1000, -1000]);
    expect(ryuukyokuDeltas([true, true, false, false])).toEqual([1500, 1500, -1500, -1500]);
    expect(ryuukyokuDeltas([true, true, true, true])).toEqual([0, 0, 0, 0]);
  });
});

describe('scoring: tenpai detection', () => {
  it('detects a tenpai hand', () => {
    // 234m 456p 678p 99m 23s → waiting 1s/4s
    expect(isTenpai(counts([12, 13, 14, 24, 25, 26, 26, 27, 28, 19, 19, 32, 33]), 0)).toBe(true);
  });
  it('detects a noten hand', () => {
    expect(isTenpai(counts([11, 13, 15, 24, 26, 28, 31, 33, 35, 41, 43, 45, 47]), 0)).toBe(false);
  });
});
