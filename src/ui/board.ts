/** Live top-down mahjong table render of a Kyoku, for verifying a transcription.
 *  Bottom = current East (dealer); rivers + melds sit in the central pond,
 *  each rotated to face outward toward its seat (riichi tiles laid sideways). */

import type { Kyoku, PlayerHand } from '../core/model.js';
import type { TenhouTile } from '../core/tiles.js';
import { tileLabel } from '../core/tileDisplay.js';
import { tileImg } from './tileEl.js';
import { roundName } from './state.js';
import { el } from './dom.js';

// seat 0..3 → position around the table (bottom=E, right=S, top=W, left=N)
const POS = ['bottom', 'right', 'top', 'left'] as const;
const WINDS = ['E', 'S', 'W', 'N'];

const miniTile = (t: TenhouTile, cls = ''): HTMLElement => tileImg(t, cls);

/** Approximate concealed hand for display: haipai + draws − discards − meld tiles. */
function reconstructHand(p: PlayerHand): TenhouTile[] {
  const hand = [...p.haipai];
  for (const t of p.turns) if (t.draw !== undefined) hand.push(t.draw);
  const remove = (tile: TenhouTile) => { const i = hand.indexOf(tile); if (i >= 0) hand.splice(i, 1); };
  for (const t of p.turns) if (t.discard !== undefined) remove(t.discard);
  for (const c of p.calls) for (const mt of c.tiles) remove(mt);
  return hand.sort((a, b) => a - b);
}

function riverEl(p: PlayerHand, seat: number): HTMLElement {
  const r = el('div', { class: `river riv-${POS[seat]}` });
  for (const t of p.turns) {
    if (t.discard === undefined) continue;
    const cls = (t.riichi ? 'riichi ' : '') + (t.tsumogiri ? 'tsumogiri' : '');
    r.append(miniTile(t.discard, cls));
  }
  return r;
}

function meldsEl(p: PlayerHand, seat: number): HTMLElement {
  const m = el('div', { class: `melds melds-${POS[seat]}` });
  for (const c of p.calls) {
    m.append(el('span', { class: 'meld', title: c.type },
      c.tiles.map((t, i) => miniTile(t, c.calledTile !== undefined && t === c.calledTile && i === 0 ? 'called' : ''))));
  }
  return m;
}

function station(k: Kyoku, seat: number): HTMLElement {
  const p = k.players[seat];
  const isDealer = (k.round % 4) === seat;
  const wind = WINDS[((seat - (k.round % 4)) + 4) % 4];
  const hand = reconstructHand(p);
  return el('div', { class: `station station-${POS[seat]}` }, [
    el('div', { class: 'seat-head' }, [
      el('span', { class: `wind wind-${wind}${isDealer ? ' dealer' : ''}` }, [wind]),
      el('span', { class: 'seat-name' }, [p.name]),
      el('span', { class: 'seat-score' }, [String(p.startScore + p.scoreDelta)]),
    ]),
    el('div', { class: 'hand' }, hand.map((t) => miniTile(t))),
  ]);
}

export function renderBoard(container: HTMLElement, k: Kyoku | undefined): void {
  container.replaceChildren();
  if (!k) { container.append(el('div', { class: 'board-empty' }, ['No hand to display'])); return; }

  const center = el('div', { class: 'pond-center' }, [
    el('div', { class: 'bc-round' }, [`${roundName(k.round)}${k.honba ? ` · ${k.honba}b` : ''}`]),
    el('div', { class: 'bc-dora' }, ['Dora ', ...k.doraIndicators.map((t) => miniTile(t)), ...(k.uraIndicators.length ? [el('span', { class: 'ura-lab' }, ['Ura']), ...k.uraIndicators.map((t) => miniTile(t))] : [])]),
    el('div', { class: 'bc-sticks' }, [`${k.riichiSticks}×1000`]),
    el('div', { class: `bc-result ${k.result.kind}` }, [resultText(k)]),
  ]);

  const pond = el('div', { class: 'pond' }, [center]);
  for (let s = 0; s < 4; s++) { pond.append(riverEl(k.players[s], s), meldsEl(k.players[s], s)); }

  container.append(el('div', { class: 'board' }, [
    station(k, 2), // West (top)
    station(k, 3), // North (left)
    pond,
    station(k, 1), // South (right)
    station(k, 0), // East (bottom)
  ]));
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
