/** Top-down mahjong table render, driven by a normalized BoardView so both the
 *  editor (a Kyoku, end state) and the replayer (a Step, mid-hand) can render it.
 *  Bottom = player index 0; right/top/left = 1/2/3. Winds rotate with the round. */

import type { Kyoku, PlayerHand } from '../core/model.js';
import type { TenhouTile } from '../core/tiles.js';
import { indicatorToDora, compareTiles } from '../core/tiles.js';
import { tileImg, tileBack } from './tileEl.js';
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
export interface BoardResultWinner { seat: number; scoreEn?: string; }
export interface BoardResult {
  kind: 'tsumo' | 'ron' | 'ryuukyoku';
  winners: BoardResultWinner[];
  loser?: number;
  winningTile?: TenhouTile;
  note?: string; // e.g. "3 tenpai" at a draw
}
export interface BoardView {
  round: number; honba: number; sticks: number; dora: TenhouTile[]; ura: TenhouTile[];
  seats: [BoardSeat, BoardSeat, BoardSeat, BoardSeat]; // by player index 0..3
  result?: BoardResult;
  highlight?: { seat: number; tile?: TenhouTile };
  title?: string; // game-record / tournament name, shown in the compass
}

/** Top-left compass: record name, round, honba / riichi-stick counts, and the
 *  actual dora (and ura, set apart) — not the indicators. */
/** Game-info panel above the board: record name over a row of round /
 *  honba·sticks / dora / ura. Sits as a header, not a floating overlay. */
function compassEl(view: BoardView): HTMLElement {
  const deposit = view.sticks + view.seats.filter((s) => s.riichi).length; // carried + this round's bets
  const row: (Node | string)[] = [
    el('div', { class: 'compass-round' }, [roundName(view.round)]),
    el('div', { class: 'compass-mid' }, [
      el('div', { class: 'compass-count', title: `${view.honba} honba` }, [el('span', { class: 'pt-stick honba' }, [el('span', { class: 'pips' })]), String(view.honba)]),
      el('div', { class: 'compass-count', title: `${deposit} riichi stick(s) in deposit` }, [el('span', { class: 'pt-stick riichi' }), String(deposit)]),
    ]),
  ];
  if (view.dora.length) row.push(el('div', { class: 'compass-dora' }, [el('span', { class: 'compass-lbl' }, ['dora']), ...view.dora.map((t) => miniTile(indicatorToDora(t)))]));
  if (view.ura.length) row.push(el('div', { class: 'compass-ura' }, [el('span', { class: 'compass-lbl' }, ['ura']), ...view.ura.map((t) => miniTile(indicatorToDora(t)))]));
  return el('div', { class: 'compass' }, [
    ...(view.title ? [el('div', { class: 'compass-title' }, [view.title])] : []),
    el('div', { class: 'compass-row' }, row),
  ]);
}

const WIN_LIMITS: Record<string, string> = {
  '数え役満': 'Counted yakuman', '三倍満': 'Sanbaiman', '倍満': 'Baiman', '跳満': 'Haneman', '満貫': 'Mangan', '役満': 'Yakuman',
};
/** Turn a tenhou score string ("30符1飜1000点", "満貫8000点", "2000点∀") into English. */
export function scoreEnglish(scoreText?: string): string | undefined {
  if (!scoreText) return undefined;
  let value = '';
  const fh = scoreText.match(/^(\d+)符(\d+)飜/);
  if (fh) value = `${fh[2]} han, ${fh[1]} fu`;
  else { const lim = scoreText.match(/^(数え役満|三倍満|倍満|跳満|満貫|役満)/); if (lim) value = WIN_LIMITS[lim[1]]; }
  let points = '';
  const pts = scoreText.match(/(\d+(?:-\d+)?)点(∀)?/);
  if (pts) {
    if (pts[2]) points = `${pts[1]} all`;                             // dealer tsumo (each pays)
    else points = `${pts[1].replace('-', '/')} pts`;                 // ron, or non-dealer tsumo split
  }
  return [value, points].filter(Boolean).join(' · ');
}

const miniTile = (t: TenhouTile, cls = ''): HTMLElement => tileImg(t, cls);

/** Seats whose concealed hand is currently hidden (shown as tile backs).
 *  Persists across re-renders and mode switches so a toggle stays put. */
const hiddenHands = new Set<number>();

/** Approximate concealed hand for the editor's Kyoku: haipai + draws − discards − melds. */
function reconstructHand(p: PlayerHand): TenhouTile[] {
  const hand = [...p.haipai];
  for (const t of p.turns) if (t.draw !== undefined) hand.push(t.draw);
  const remove = (tile: TenhouTile) => { const i = hand.indexOf(tile); if (i >= 0) hand.splice(i, 1); };
  for (const t of p.turns) if (t.discard !== undefined) remove(t.tsumogiri ? t.draw! : t.discard);
  for (const c of p.calls) {
    // Only the tiles that came from THIS hand leave it — not the called tile,
    // which came from an opponent's discard. Removing it too would wrongly drop
    // a same-valued tile the player legitimately holds (e.g. a later draw).
    const fromHand = [...c.tiles];
    if (c.calledTile !== undefined) { const i = fromHand.indexOf(c.calledTile); if (i >= 0) fromHand.splice(i, 1); }
    for (const mt of fromHand) remove(mt);
  }
  return hand.sort(compareTiles);
}

export function kyokuToBoardView(k: Kyoku, title?: string): BoardView {
  const seats = k.players.map((p, i): BoardSeat => {
    const hand = reconstructHand(p);
    let drawn: TenhouTile | undefined;
    // On a tsumo win the winning tile is held apart on the right.
    if (k.result.kind === 'tsumo' && k.result.winner === i && k.result.winningTile !== undefined) {
      drawn = k.result.winningTile; const idx = hand.indexOf(drawn); if (idx >= 0) hand.splice(idx, 1);
    } else {
      // Mid-hand: a drawn-but-not-yet-discarded tile is held apart too, so the
      // just-drawn tile reads as such rather than sorting into the hand.
      const last = p.turns[p.turns.length - 1];
      if (last && last.draw !== undefined && last.discard === undefined) {
        drawn = last.draw; const idx = hand.indexOf(drawn); if (idx >= 0) hand.splice(idx, 1);
      }
    }
    return {
      name: p.name, score: p.startScore + p.scoreDelta, riichi: p.turns.some((t) => t.riichi),
      hand, drawn,
      river: p.turns.filter((t) => t.discard !== undefined).map((t) => ({ tile: t.tsumogiri ? t.draw! : t.discard!, tsumogiri: t.tsumogiri, riichi: t.riichi, called: t.called })),
      melds: p.calls.map((c) => ({ type: c.type, tiles: c.tiles, called: c.calledTile, from: c.fromSeat })),
    };
  }) as BoardView['seats'];
  return { round: k.round, honba: k.honba, sticks: k.riichiSticks, dora: k.doraIndicators, ura: k.uraIndicators, seats, result: boardResult(k), title };
}

function boardResult(k: Kyoku): BoardResult | undefined {
  const r = k.result;
  if (r.kind === 'ryuukyoku') {
    const note = r.tenpai?.length ? `${r.tenpai.length} tenpai` : undefined;
    return { kind: 'ryuukyoku', winners: [], note };
  }
  const winners: BoardResultWinner[] = r.wins?.length
    ? r.wins.map((w) => ({ seat: w.winner, scoreEn: scoreEnglish(w.scoreText) }))
    : (r.winner !== undefined ? [{ seat: r.winner, scoreEn: scoreEnglish(r.scoreText) }] : []);
  return { kind: r.kind, winners, loser: r.loser, winningTile: r.winningTile };
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

function station(view: BoardView, seat: number, rerender: () => void): HTMLElement {
  const s = view.seats[seat];
  // A winner's hand is always revealed at the ron/tsumo result, even if hidden.
  const revealWinner = !!view.result && view.result.kind !== 'ryuukyoku' && view.result.winners.some((w) => w.seat === seat);
  const hide = hiddenHands.has(seat) && !revealWinner;
  const flipped = seat === 1 || seat === 2; // South/West read right-to-left once rotated
  const hand = [...s.hand];
  if (flipped) hand.reverse();
  const tiles: HTMLElement[] = hand.map((t) => hide ? tileBack() : miniTile(t));
  if (s.drawn !== undefined) {
    const drawn = hide ? tileBack('drawn') : miniTile(s.drawn, 'drawn');
    const extra = [el('span', { class: 'hand-gap' }), drawn];
    if (flipped) tiles.unshift(extra[1], extra[0]); else tiles.push(...extra);
  }
  const children: (Node | string)[] = [el('div', { class: 'hand' }, tiles)];
  // No toggle for a revealed winner — the winning hand can't be hidden.
  if (!revealWinner) {
    children.push(el('button', {
      class: `hand-toggle${hide ? ' on' : ''}`, title: hide ? 'Show this hand' : 'Hide this hand',
      onClick: (e: Event) => { e.stopPropagation(); if (hiddenHands.has(seat)) hiddenHands.delete(seat); else hiddenHands.add(seat); rerender(); },
    }, [hide ? 'Show' : 'Hide']));
  }
  return el('div', { class: `station station-${POS[seat]}` }, children);
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
  // Round / honba / sticks / dora now live in the top-left compass; the centre
  // keeps only the win / draw result.
  const mid = el('div', { class: 'sc-mid' }, [
    ...(view.result ? [resultEl(view.result, view.seats)] : []),
  ]);
  const rerender = () => renderBoardView(container, view);
  const center = el('div', { class: 'pond-center' }, [scoreBlock(view, 2), scoreBlock(view, 3), mid, scoreBlock(view, 1), scoreBlock(view, 0)]);
  const pond = el('div', { class: 'pond' }, [center]);
  for (let s = 0; s < 4; s++) pond.append(riverEl(view.seats[s].river, s), meldsEl(view.seats[s].melds, s));
  const board = el('div', { class: 'board' }, [station(view, 2, rerender), station(view, 3, rerender), pond, station(view, 1, rerender), station(view, 0, rerender)]);
  // Game info is its own horizontal row above the board, not a floating overlay.
  container.append(el('div', { class: 'board-area' }, [compassEl(view), board]));
}

/** Convenience wrapper for the editor's live board. */
export function renderBoard(container: HTMLElement, k: Kyoku | undefined, title?: string): void {
  renderBoardView(container, k ? kyokuToBoardView(k, title) : undefined);
}

/** Render the centre result: winner name(s) + the winning tile image, with the
 *  hand value in English on a second line. */
export function resultEl(res: BoardResult, seats: { name: string }[]): HTMLElement {
  const nameOf = (s: number) => seats[s]?.name || `P${s}`;
  const cls = `bc-result ${res.kind}`;
  if (res.kind === 'ryuukyoku') {
    return el('div', { class: cls }, [
      el('div', { class: 'bc-result-line' }, ['Exhaustive draw']),
      ...(res.note ? [el('div', { class: 'bc-result-score' }, [res.note])] : []),
    ]);
  }
  const verb = res.kind === 'tsumo' ? 'tsumo' : 'ron';
  const line: (Node | string)[] = [el('span', { class: 'res-who' }, [res.winners.map((w) => nameOf(w.seat)).join(' + ')]), ` ${verb} `];
  if (res.winningTile !== undefined) line.push(miniTile(res.winningTile));
  if (res.kind === 'ron' && res.loser !== undefined) line.push(' off ', el('span', { class: 'res-who' }, [nameOf(res.loser)]));

  const scoreLine = res.winners.length > 1
    ? res.winners.filter((w) => w.scoreEn).map((w) => `${nameOf(w.seat)}: ${w.scoreEn}`).join(' · ')
    : res.winners[0]?.scoreEn;
  return el('div', { class: cls }, [
    el('div', { class: 'bc-result-line' }, line),
    ...(scoreLine ? [el('div', { class: 'bc-result-score' }, [scoreLine])] : []),
  ]);
}
