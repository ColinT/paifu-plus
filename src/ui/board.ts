/** Top-down mahjong table render, driven by a normalized BoardView so both the
 *  editor (a Kyoku, end state) and the replayer (a Step, mid-hand) can render it.
 *  Bottom = player index 0; right/top/left = 1/2/3. Winds rotate with the round. */

import type { Kyoku, PlayerHand } from '../core/model.js';
import type { TenhouTile } from '../core/tiles.js';
import { tileLabel } from '../core/tileDisplay.js';
import { tileImg } from './tileEl.js';
import { roundName } from './state.js';
import { el } from './dom.js';

const POS = ['bottom', 'right', 'top', 'left'] as const;
const WINDS = ['E', 'S', 'W', 'N'];

export interface BoardRiverTile { tile: TenhouTile; tsumogiri?: boolean; riichi?: boolean; called?: boolean; }
export interface BoardMeld { type: string; tiles: TenhouTile[]; called?: TenhouTile; from?: number; }
export interface BoardSeat {
  name: string; score: number; riichi: boolean;
  hand: TenhouTile[]; river: BoardRiverTile[]; melds: BoardMeld[];
  drawn?: TenhouTile; // the just-drawn tile, held apart on the player's right
}
export interface BoardView {
  round: number; honba: number; sticks: number; dora: TenhouTile[]; ura: TenhouTile[];
  seats: [BoardSeat, BoardSeat, BoardSeat, BoardSeat]; // by player index 0..3
  resultText?: string;
  highlight?: { seat: number; tile?: TenhouTile };
}

const miniTile = (t: TenhouTile, cls = ''): HTMLElement => tileImg(t, cls);

/** Approximate concealed hand for the editor's Kyoku: haipai + draws − discards − melds. */
function reconstructHand(p: PlayerHand): TenhouTile[] {
  const hand = [...p.haipai];
  for (const t of p.turns) if (t.draw !== undefined) hand.push(t.draw);
  const remove = (tile: TenhouTile) => { const i = hand.indexOf(tile); if (i >= 0) hand.splice(i, 1); };
  for (const t of p.turns) if (t.discard !== undefined) remove(t.tsumogiri ? t.draw! : t.discard);
  for (const c of p.calls) for (const mt of c.tiles) remove(mt);
  return hand.sort((a, b) => a - b);
}

export function kyokuToBoardView(k: Kyoku): BoardView {
  const seats = k.players.map((p, i): BoardSeat => {
    const hand = reconstructHand(p);
    let drawn: TenhouTile | undefined;
    // On a tsumo win the winning tile is held apart on the right.
    if (k.result.kind === 'tsumo' && k.result.winner === i && k.result.winningTile !== undefined) {
      drawn = k.result.winningTile; const idx = hand.indexOf(drawn); if (idx >= 0) hand.splice(idx, 1);
    }
    return {
      name: p.name, score: p.startScore + p.scoreDelta, riichi: p.turns.some((t) => t.riichi),
      hand, drawn,
      river: p.turns.filter((t) => t.discard !== undefined).map((t) => ({ tile: t.tsumogiri ? t.draw! : t.discard!, tsumogiri: t.tsumogiri, riichi: t.riichi, called: t.called })),
      melds: p.calls.map((c) => ({ type: c.type, tiles: c.tiles, called: c.calledTile, from: c.fromSeat })),
    };
  }) as BoardView['seats'];
  return { round: k.round, honba: k.honba, sticks: k.riichiSticks, dora: k.doraIndicators, ura: k.uraIndicators, seats, resultText: resultText(k) };
}

function calledPosition(seat: number, fromSeat: number, n: number): number {
  const d = ((fromSeat - seat) + 4) % 4;
  if (d === 3) return 0; if (d === 2) return 1; return n - 1;
}

function riverEl(river: BoardRiverTile[], seat: number): HTMLElement {
  const r = el('div', { class: `river riv-${POS[seat]}` });
  for (const t of river) {
    const cls = [t.riichi && 'riichi', t.tsumogiri && 'tsumogiri', t.called && 'called'].filter(Boolean).join(' ');
    r.append(miniTile(t.tile, cls));
  }
  return r;
}

function meldsEl(melds: BoardMeld[], seat: number): HTMLElement {
  const m = el('div', { class: `melds melds-${POS[seat]}` });
  for (const c of melds) {
    let cells: { t: TenhouTile; called: boolean }[] = c.tiles.map((t) => ({ t, called: false }));
    if (c.called !== undefined && c.from !== undefined) {
      const pos = calledPosition(seat, c.from, c.tiles.length);
      const others = [...c.tiles]; const ci = others.indexOf(c.called); if (ci >= 0) others.splice(ci, 1);
      cells = []; let oi = 0;
      for (let k = 0; k < c.tiles.length; k++) cells.push(k === pos ? { t: c.called, called: true } : { t: others[oi++], called: false });
    }
    m.append(el('span', { class: 'meld', title: c.type }, cells.map((o) => miniTile(o.t, o.called ? 'called' : ''))));
  }
  return m;
}

function station(view: BoardView, seat: number): HTMLElement {
  const s = view.seats[seat];
  const flipped = seat === 1 || seat === 2; // South/West read right-to-left once rotated
  const hand = [...s.hand];
  if (flipped) hand.reverse();
  const tiles: HTMLElement[] = hand.map((t) => miniTile(t));
  if (s.drawn !== undefined) {
    const extra = [el('span', { class: 'hand-gap' }), miniTile(s.drawn, 'drawn')];
    if (flipped) tiles.unshift(extra[1], extra[0]); else tiles.push(...extra);
  }
  return el('div', { class: `station station-${POS[seat]}` }, [el('div', { class: 'hand' }, tiles)]);
}

function scoreBlock(view: BoardView, seat: number): HTMLElement {
  const s = view.seats[seat];
  const isDealer = (view.round % 4) === seat;
  const wind = WINDS[((seat - (view.round % 4)) + 4) % 4];
  return el('div', { class: `sc sc-${POS[seat]}` }, [
    el('div', { class: 'sc-head' }, [el('span', { class: `wind wind-${wind}${isDealer ? ' dealer' : ''}` }, [wind]), el('span', { class: 'sc-name' }, [s.name])]),
    el('div', { class: 'sc-pts' }, [String(s.score)]),
    ...(s.riichi ? [el('div', { class: 'stick' })] : []),
  ]);
}

export function renderBoardView(container: HTMLElement, view: BoardView | undefined): void {
  container.replaceChildren();
  if (!view) { container.append(el('div', { class: 'board-empty' }, ['No hand to display'])); return; }
  const mid = el('div', { class: 'sc-mid' }, [
    el('div', { class: 'bc-round' }, [`${roundName(view.round)}${view.honba ? ` · ${view.honba}b` : ''}`]),
    el('div', { class: 'bc-dora' }, ['ドラ ', ...view.dora.map((t) => miniTile(t)), ...(view.ura.length ? [el('span', { class: 'ura-lab' }, ['裏']), ...view.ura.map((t) => miniTile(t))] : [])]),
    ...(view.sticks ? [el('div', { class: 'bc-sticks' }, [`供託 ${view.sticks}`])] : []),
    ...(view.resultText ? [el('div', { class: 'bc-result' }, [view.resultText])] : []),
  ]);
  const center = el('div', { class: 'pond-center' }, [scoreBlock(view, 2), scoreBlock(view, 3), mid, scoreBlock(view, 1), scoreBlock(view, 0)]);
  const pond = el('div', { class: 'pond' }, [center]);
  for (let s = 0; s < 4; s++) pond.append(riverEl(view.seats[s].river, s), meldsEl(view.seats[s].melds, s));
  container.append(el('div', { class: 'board' }, [station(view, 2), station(view, 3), pond, station(view, 1), station(view, 0)]));
}

/** Convenience wrapper for the editor's live board. */
export function renderBoard(container: HTMLElement, k: Kyoku | undefined): void {
  renderBoardView(container, k ? kyokuToBoardView(k) : undefined);
}

function resultText(k: Kyoku): string {
  const r = k.result;
  if (r.kind === 'ryuukyoku') return 'Exhaustive draw';
  const who = r.winner !== undefined ? `P${r.winner}` : '?';
  const tile = r.winningTile !== undefined ? tileLabel(r.winningTile) : '';
  const score = r.scoreText ? ` · ${r.scoreText}` : '';
  if (r.kind === 'tsumo') return `${who} tsumo ${tile}${score}`;
  return `${who} ron ${tile}${r.loser !== undefined ? ` off P${r.loser}` : ''}${score}`;
}
