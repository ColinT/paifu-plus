/**
 * Intermediate game model.
 *
 * This is the single source of truth that both the PDF importer and the manual
 * editor produce, and that the tenhou emitter consumes. It stays deliberately
 * close to how a hand is actually played (per-player draw/discard streams,
 * explicit calls) so both producers can populate it naturally and the emitter
 * can flatten it into tenhou's arrays.
 */

import type { TenhouTile } from './tiles.js';

/** Seat index: 0=East, 1=South, 2=West, 3=North (dealer is seat with kyoku's oya). */
export type Seat = 0 | 1 | 2 | 3;

export type CallType = 'chi' | 'pon' | 'ankan' | 'daiminkan' | 'kakan';

export interface Call {
  type: CallType;
  /** The tiles forming the meld, in tenhou codes (includes the called tile). */
  tiles: TenhouTile[];
  /** The specific tile taken from an opponent (undefined for ankan). */
  calledTile?: TenhouTile;
  /** Seat the called tile was taken from (undefined for ankan). */
  fromSeat?: Seat;
  /**
   * Turn index (0-based over this player's draws) at which the call was made.
   * Used to interleave the call into the tenhou draw stream.
   */
  turn: number;
}

/** One draw+discard turn for a player. */
export interface Turn {
  /** Tile drawn this turn (tenhou code). Omitted for a called turn (no draw). */
  draw?: TenhouTile;
  /** Tile discarded this turn (tenhou code). Omitted on the winning tsumo turn. */
  discard?: TenhouTile;
  /** True if the discard was the just-drawn tile (tenhou code 60). */
  tsumogiri?: boolean;
  /** True if this discard is the riichi declaration tile. */
  riichi?: boolean;
}

export interface PlayerHand {
  seat: Seat;
  name: string;
  /** Points before this hand. */
  startScore: number;
  /** Net point change this hand (from the paifun 動き + 積棒 + 立棒). */
  scoreDelta: number;
  /** 13 starting tiles (14 for the dealer's opening, if the source includes it). */
  haipai: TenhouTile[];
  turns: Turn[];
  calls: Call[];
  /** Final hand shown in 最終形, if available (used to recompute yaku). */
  finalHand?: TenhouTile[];
}

export type EndKind = 'tsumo' | 'ron' | 'ryuukyoku';

export interface KyokuResult {
  kind: EndKind;
  /** Winner seat for tsumo/ron. */
  winner?: Seat;
  /** Seat that dealt in (ron only). */
  loser?: Seat;
  /** The winning tile (ron/tsumo). */
  winningTile?: TenhouTile;
  /** Per-seat point deltas for the tenhou result array. */
  deltas: [number, number, number, number];
  /** Seats that were tenpai at an exhaustive draw. */
  tenpai?: Seat[];
}

export interface Kyoku {
  /** tenhou round index: 0=E1,1=E2,2=E3,3=E4,4=S1,... */
  round: number;
  honba: number;
  riichiSticks: number;
  /** Dora indicator tiles (revealed). */
  doraIndicators: TenhouTile[];
  /** Ura-dora indicator tiles (revealed on a riichi win). */
  uraIndicators: TenhouTile[];
  /** Players indexed by seat 0..3. */
  players: [PlayerHand, PlayerHand, PlayerHand, PlayerHand];
  result: KyokuResult;
}

export interface GameMeta {
  title: string[];
  /** Player names indexed by seat for the whole game (seat 0..3 at game start). */
  names: [string, string, string, string];
  /** tenhou rule descriptor. aka=1 means red fives in play. */
  rule: { disp?: string; aka?: number };
}

export interface Game {
  meta: GameMeta;
  kyokus: Kyoku[];
}
