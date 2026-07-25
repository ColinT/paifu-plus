/**
 * Replay engine: expand a tenhou.net/6 JSON log into a sequence of board-state
 * snapshots so a viewer can step through a hand move-by-move.
 *
 * It re-simulates turn order from the per-player draw/discard streams, handling
 * tsumogiri (60), riichi ("r"), calls (chi/pon/kan meld strings that interrupt
 * the turn order), ankan, and the win/draw ending.
 */

import type { TenhouTile } from '../core/tiles.js';

export interface RiverTile { tile: TenhouTile; tsumogiri: boolean; riichi: boolean; called: boolean; }
export interface ReplayMeld { type: string; tiles: TenhouTile[]; called?: TenhouTile; from?: number; }
export interface ReplayPlayer { hand: TenhouTile[]; river: RiverTile[]; melds: ReplayMeld[]; score: number; riichi: boolean; drawn: TenhouTile | null; }

export type ActionType = 'haipai' | 'draw' | 'discard' | 'call' | 'kan' | 'end';
export interface Step {
  players: [ReplayPlayer, ReplayPlayer, ReplayPlayer, ReplayPlayer];
  active: number;          // seat that just acted
  action: ActionType;
  tile?: TenhouTile;       // the drawn/discarded tile, when relevant
  label: string;           // short human description
}

export interface KyokuReplay {
  round: number; honba: number; sticks: number;
  dora: TenhouTile[]; ura: TenhouTile[];
  dealer: number;
  result: unknown;
  steps: Step[];
}

export interface ReplayGame {
  names: string[];
  rule: { disp?: string; aka?: number };
  kyokus: KyokuReplay[];
}

const norm = (t: TenhouTile) => (t === 51 ? 15 : t === 52 ? 25 : t === 53 ? 35 : t);

function parseMeld(s: string): { type: string; tiles: TenhouTile[]; called?: TenhouTile } {
  const idx = s.search(/[a-z]/i);
  const letter = s[idx].toLowerCase();
  const before = (s.slice(0, idx).match(/\d\d/g) ?? []).map(Number);
  const after = (s.slice(idx + 1).match(/\d\d/g) ?? []).map(Number);
  const type = letter === 'p' ? 'pon' : letter === 'c' ? 'chi' : letter === 'm' ? 'daiminkan' : letter === 'k' ? 'kakan' : 'ankan';
  const called = type === 'ankan' ? undefined : after[0];
  return { type, tiles: [...before, ...after], called };
}

/** Does this meld string claim `tile` from an opponent (chi/pon/daiminkan)? */
function callsDiscard(s: string, tile: TenhouTile): boolean {
  if (!/[pcm]/i.test(s)) return false;
  const { called } = parseMeld(s);
  return called !== undefined && norm(called) === norm(tile);
}

function removeOne(hand: TenhouTile[], tile: TenhouTile) {
  let i = hand.indexOf(tile);
  if (i < 0) i = hand.findIndex((h) => norm(h) === norm(tile));
  if (i >= 0) hand.splice(i, 1);
}

const clone = (p: ReplayPlayer): ReplayPlayer => ({
  hand: [...p.hand], river: p.river.map((r) => ({ ...r })), melds: p.melds.map((m) => ({ ...m, tiles: [...m.tiles] })), score: p.score, riichi: p.riichi, drawn: p.drawn,
});

function simulateKyoku(entry: any[]): KyokuReplay {
  const [round, honba, sticks] = entry[0] as number[];
  const scores = entry[1] as number[];
  const dora = (entry[2] ?? []) as TenhouTile[];
  const ura = (entry[3] ?? []) as TenhouTile[];
  const haipai: TenhouTile[][] = [], draws: any[][] = [], discards: any[][] = [];
  for (let p = 0; p < 4; p++) { haipai[p] = entry[4 + p * 3]; draws[p] = entry[5 + p * 3]; discards[p] = entry[6 + p * 3]; }
  const result = entry[16];

  const P: ReplayPlayer[] = Array.from({ length: 4 }, (_, p) => ({
    hand: [...haipai[p]].sort((a, b) => a - b), river: [], melds: [], score: scores[p], riichi: false, drawn: null,
  }));
  const dp = [0, 0, 0, 0], sp = [0, 0, 0, 0];
  const dealer = round % 4;
  let current = dealer;
  let lastDraw: TenhouTile | null = null;
  let lastDiscarder = -1;

  const steps: Step[] = [];
  const snap = (action: ActionType, seat: number, tile: TenhouTile | undefined, label: string) =>
    steps.push({ players: P.map(clone) as Step['players'], active: seat, action, tile, label });

  snap('haipai', dealer, undefined, 'Deal');

  let guard = 0;
  while (guard++ < 400) {
    const d = draws[current]?.[dp[current]];
    if (d === undefined) break; // player has no more actions → hand has ended

    // ---- draw / call ----
    if (typeof d === 'string') {
      const meld = parseMeld(d);
      // tiles that came from the caller's hand (all but one called copy)
      const fromHand = [...meld.tiles];
      if (meld.called !== undefined) { const i = fromHand.findIndex((x) => norm(x) === norm(meld.called!)); if (i >= 0) fromHand.splice(i, 1); }
      for (const t of fromHand) removeOne(P[current].hand, t);
      P[current].melds.push({ type: meld.type, tiles: meld.tiles, called: meld.called, from: lastDiscarder >= 0 ? lastDiscarder : undefined });
      dp[current]++;
      lastDraw = null; P[current].drawn = null;
      snap('call', current, meld.called, meld.type);
    } else {
      P[current].hand.push(d); P[current].hand.sort((a, b) => a - b);
      lastDraw = d; dp[current]++; P[current].drawn = d;
      snap('draw', current, d, 'Draw');
    }

    // ---- discard (or kan, or tsumo end) ----
    const s = discards[current]?.[sp[current]];
    if (s === undefined) { snap('end', current, lastDraw ?? undefined, 'Tsumo'); break; }

    if (typeof s === 'string' && /[akm]/.test(s) && !/^r/.test(s)) {
      // ankan/added-kan declared in the discard slot → draw a replacement next
      const meld = parseMeld(s);
      for (const t of meld.tiles) removeOne(P[current].hand, t);
      P[current].melds.push({ type: meld.type, tiles: meld.tiles });
      sp[current]++;
      snap('kan', current, undefined, meld.type);
      continue; // same player draws rinshan
    }

    let riichi = false; let str: string | number = s;
    if (typeof str === 'string' && str.startsWith('r')) { riichi = true; str = str.slice(1); }
    const tsumogiri = String(str) === '60';
    const tile = tsumogiri ? (lastDraw ?? 0) : Number(str);
    removeOne(P[current].hand, tile);
    P[current].river.push({ tile, tsumogiri, riichi, called: false });
    if (riichi) { P[current].riichi = true; P[current].score -= 1000; }
    sp[current]++;
    lastDiscarder = current;
    P[current].drawn = null; // turn complete, no tile held apart
    snap('discard', current, tile, riichi ? 'Riichi' : tsumogiri ? 'Tsumogiri' : 'Discard');

    // ---- did someone call this discard? ----
    let caller: number | null = null;
    for (let q = 0; q < 4; q++) {
      if (q === current) continue;
      const nd = draws[q]?.[dp[q]];
      if (typeof nd === 'string' && callsDiscard(nd, tile)) { caller = q; break; }
    }
    if (caller !== null) { P[current].river[P[current].river.length - 1].called = true; current = caller; }
    else current = (current + 1) % 4;
  }

  if (steps[steps.length - 1]?.action !== 'end') snap('end', current, undefined, 'End');
  return { round, honba, sticks, dora, ura, dealer, result, steps };
}

export function buildReplay(log: any): ReplayGame {
  const kyokus = (log.log ?? []).map(simulateKyoku);
  return { names: log.name ?? ['P1', 'P2', 'P3', 'P4'], rule: log.rule ?? {}, kyokus };
}
