import type { TenhouTile } from '../core/tiles.js';

export type WaitType = 'ryanmen' | 'kanchan' | 'penchan' | 'shanpon' | 'tanki';

/** A finalized set within a winning hand (34-index start). */
export interface FullSet {
  type: 'seq' | 'triplet' | 'kan';
  start: number;
  open: boolean;      // came from a call / completed by ron (for sanankou)
  kanClosed?: boolean; // ankan
}

export interface Rules {
  aka?: number;          // number of red fives in the wall (0 = none)
  kuitan?: boolean;      // open tanyao allowed (default true)
  kiriageMangan?: boolean;
  doubleWindPairFu?: boolean; // 4 fu for a round==seat wind pair (default true)
}

export interface WinContext {
  /** Concealed tiles held at the win, EXCLUDING the winning tile. */
  concealed: TenhouTile[];
  /** Declared melds (chi/pon/kan). */
  melds: { type: string; tiles: TenhouTile[] }[];
  winningTile: TenhouTile;
  isTsumo: boolean;
  seatWind: number;   // 34-index (27=E..30=N)
  roundWind: number;  // 34-index
  doraIndicators: TenhouTile[];
  uraIndicators: TenhouTile[];
  riichi?: boolean;
  doubleRiichi?: boolean;
  ippatsu?: boolean;
  haitei?: boolean;
  houtei?: boolean;
  rinshan?: boolean;
  chankan?: boolean;
  rules: Rules;
}

export interface YakuLine { name: string; han: number; }

export interface ScoreResult {
  valid: boolean;     // has at least one yaku (or yakuman)
  yaku: YakuLine[];
  yakuman: number;
  han: number;        // total han (incl. dora), 0 for yakuman
  fu: number;
  base: number;       // base points `a` (payments are multiples of this)
  limitName: string | null; // 満貫/跳満/…/役満, or null
  /** tenhou-style scoring string, e.g. "30符3飜" or "跳満". */
  text: string;
}
