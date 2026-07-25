/** Editor state: the working Game plus helpers to create/derive it. */

import type { Game, Kyoku, PlayerHand, Seat } from '../core/model.js';

export interface EditorState {
  game: Game;
  activeKyoku: number;
}

export function emptyPlayer(seat: Seat): PlayerHand {
  return { seat, name: `Player ${seat + 1}`, startScore: 25000, scoreDelta: 0, haipai: [], turns: [], calls: [] };
}

export function emptyKyoku(round = 0): Kyoku {
  return {
    round, honba: 0, riichiSticks: 0,
    doraIndicators: [], uraIndicators: [],
    players: [emptyPlayer(0), emptyPlayer(1), emptyPlayer(2), emptyPlayer(3)],
    result: { kind: 'ryuukyoku', deltas: [0, 0, 0, 0] },
  };
}

export function newGame(): Game {
  return {
    meta: { title: ['New game', ''], names: ['Player 1', 'Player 2', 'Player 3', 'Player 4'], rule: { disp: '', aka: 0 } },
    kyokus: [emptyKyoku(0)],
  };
}

/** Build a Game from imported kyokus, deriving names from the first kyoku. */
export function gameFromKyokus(kyokus: Kyoku[], title = 'Imported from PAIFUN'): Game {
  const names = (kyokus[0]?.players.map((p) => p.name) ?? ['P1', 'P2', 'P3', 'P4']) as [string, string, string, string];
  return { meta: { title: [title, ''], names, rule: { disp: '', aka: 0 } }, kyokus: kyokus.length ? kyokus : [emptyKyoku(0)] };
}

const WINDS = ['East', 'South', 'West', 'North'];
export function roundName(round: number): string {
  return `${WINDS[Math.floor(round / 4)]} ${(round % 4) + 1}`;
}

export function seatWind(seat: Seat, round: number): string {
  // current-hand wind for a fixed player index: dealer is round%4.
  const rel = ((seat - (round % 4)) + 4) % 4;
  return ['E', 'S', 'W', 'N'][rel];
}
