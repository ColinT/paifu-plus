/** Live top-down mahjong table render of a Kyoku, for verifying a transcription.
 *  Layout: bottom = current East (dealer), right = South, top = West, left = North. */

import type { Kyoku, PlayerHand } from '../core/model.js';
import type { TenhouTile } from '../core/tiles.js';
import { tileGlyph, tileLabel, tileSuitClass } from '../core/tileDisplay.js';
import { roundName } from './state.js';
import { el } from './dom.js';

function miniTile(t: TenhouTile, cls = ''): HTMLElement {
  const { suit, red } = tileSuitClass(t);
  return el('span', { class: `bt suit-${suit}${red ? ' aka' : ''} ${cls}`, title: tileLabel(t) }, [tileGlyph(t)]);
}

/** Approximate concealed hand for display: haipai + draws − discards − meld tiles. */
function reconstructHand(p: PlayerHand): TenhouTile[] {
  const hand = [...p.haipai];
  for (const t of p.turns) if (t.draw !== undefined) hand.push(t.draw);
  const remove = (tile: TenhouTile) => { const i = hand.indexOf(tile); if (i >= 0) hand.splice(i, 1); else { const j = hand.findIndex((h) => h === tile); if (j >= 0) hand.splice(j, 1); } };
  for (const t of p.turns) if (t.discard !== undefined) remove(t.discard);
  for (const c of p.calls) for (const mt of c.tiles) remove(mt);
  return hand.sort((a, b) => a - b);
}

function river(p: PlayerHand): HTMLElement {
  const r = el('div', { class: 'river' });
  p.turns.forEach((t) => {
    if (t.discard === undefined) return;
    const cls = (t.riichi ? 'riichi ' : '') + (t.tsumogiri ? 'tsumogiri' : '');
    r.append(miniTile(t.discard, cls));
  });
  return r;
}

function melds(p: PlayerHand): HTMLElement {
  const m = el('div', { class: 'melds' });
  for (const c of p.calls) {
    const grp = el('span', { class: 'meld', title: c.type }, c.tiles.map((t) => miniTile(t)));
    m.append(grp);
  }
  return m;
}

function seatArea(k: Kyoku, seat: number, pos: string): HTMLElement {
  const p = k.players[seat];
  const isDealer = (k.round % 4) === seat;
  const winds = ['E', 'S', 'W', 'N'];
  const wind = winds[((seat - (k.round % 4)) + 4) % 4];
  const hand = reconstructHand(p);
  return el('div', { class: `seat seat-${pos}` }, [
    el('div', { class: 'seat-head' }, [
      el('span', { class: `wind wind-${wind}${isDealer ? ' dealer' : ''}` }, [wind]),
      el('span', { class: 'seat-name' }, [p.name]),
      el('span', { class: 'seat-score' }, [String(p.startScore + p.scoreDelta)]),
    ]),
    melds(p),
    el('div', { class: 'hand' }, hand.map((t) => miniTile(t))),
    river(p),
  ]);
}

export function renderBoard(container: HTMLElement, k: Kyoku | undefined): void {
  container.replaceChildren();
  if (!k) { container.append(el('div', { class: 'board-empty' }, ['No hand to display'])); return; }

  const center = el('div', { class: 'board-center' }, [
    el('div', { class: 'bc-round' }, [`${roundName(k.round)}${k.honba ? ` · ${k.honba} honba` : ''}`]),
    el('div', { class: 'bc-sticks' }, [`${k.riichiSticks} stick${k.riichiSticks === 1 ? '' : 's'}`]),
    el('div', { class: 'bc-dora' }, ['Dora ', ...k.doraIndicators.map((t) => miniTile(t)), ...(k.uraIndicators.length ? ['Ura ' as unknown as Node, ...k.uraIndicators.map((t) => miniTile(t))] : [])]),
    el('div', { class: `bc-result ${k.result.kind}` }, [resultText(k)]),
  ]);

  const board = el('div', { class: 'board' }, [
    seatArea(k, 2, 'top'),      // West
    seatArea(k, 3, 'left'),     // North
    center,
    seatArea(k, 1, 'right'),    // South
    seatArea(k, 0, 'bottom'),   // East (dealer)
  ]);
  container.append(board);
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
