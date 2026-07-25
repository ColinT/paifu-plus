/** Render the active kyoku as an editable form over the Game model.
 *
 * Primary tile entry is fast text notation (e.g. "123m0p77z"); the chip preview
 * below each field is a live view and click-to-fix for corrections. */

import type { Kyoku, PlayerHand, Turn, Seat, EndKind } from '../core/model.js';
import type { TenhouTile } from '../core/tiles.js';
import { tilesToNotation, parseTileNotation } from '../core/tiles.js';
import { tileGlyph, tileLabel, tileSuitClass } from '../core/tileDisplay.js';
import { roundName, seatWind } from './state.js';
import { pickTile } from './tilePicker.js';
import { el, clear } from './dom.js';

interface Ctx { rerender: () => void; refreshJson: () => void; }

function tileChip(t: TenhouTile, onClick?: () => void, extraClass = ''): HTMLElement {
  const { suit, red } = tileSuitClass(t);
  const c = el('button', { class: `chip suit-${suit}${red ? ' aka' : ''}${onClick ? '' : ' static'} ${extraClass}`, title: tileLabel(t) }, [
    el('span', { class: 'glyph' }, [tileGlyph(t)]),
  ]);
  if (onClick) c.onclick = onClick;
  return c;
}

/**
 * Text-first editor for a list of tiles. Typing notation updates the model
 * live (keeping input focus); the preview row shows chips and click-to-fix.
 */
function tileGroup(opts: {
  get: () => TenhouTile[];
  set: (t: TenhouTile[]) => void;
  sort?: boolean;
  placeholder?: string;
  ctx: Ctx;
  chipClass?: (t: TenhouTile, i: number) => string;
  onChip?: (i: number) => void;
}): HTMLElement {
  const wrap = el('div', { class: 'tile-group' });
  const input = el('input', { class: 'notation', spellcheck: 'false', autocapitalize: 'off', placeholder: opts.placeholder ?? '123m 45p 6s 7z' }) as HTMLInputElement;
  input.value = tilesToNotation(opts.get());
  const preview = el('div', { class: 'tile-row' });

  const renderPreview = () => {
    clear(preview);
    const tiles = opts.get();
    tiles.forEach((t, i) => {
      const onClick = opts.onChip ? () => opts.onChip!(i) : async () => {
        const r = await pickTile({ allowDelete: true, title: `Edit ${tileLabel(t)}` });
        if (r === null) return;
        const next = [...opts.get()];
        if (r === 'delete') next.splice(i, 1); else next[i] = r;
        if (opts.sort) next.sort((a, b) => a - b);
        opts.set(next); input.value = tilesToNotation(next); renderPreview(); opts.ctx.refreshJson();
      };
      preview.append(tileChip(t, onClick, opts.chipClass?.(t, i) ?? ''));
    });
    preview.append(el('span', { class: 'count' }, [String(tiles.length)]));
  };

  input.oninput = () => {
    let t = parseTileNotation(input.value);
    if (opts.sort) t = [...t].sort((a, b) => a - b);
    opts.set(t); renderPreview(); opts.ctx.refreshJson();
  };
  renderPreview();
  wrap.append(input, preview);
  return wrap;
}

function labeled(label: string, node: HTMLElement, hint?: string): HTMLElement {
  return el('div', { class: 'group-block' }, [
    el('div', { class: 'group-label' }, [label, hint ? el('span', { class: 'hint' }, [hint]) : '']),
    node,
  ]);
}

/** Get/set the draw (or discard) sequence of a player's turns, preserving the other stream + flags. */
function seqAccessors(p: PlayerHand, which: 'draw' | 'discard') {
  return {
    get: () => p.turns.map((t) => t[which]).filter((x): x is TenhouTile => x !== undefined),
    set: (seq: TenhouTile[]) => {
      const other: ('draw' | 'discard') = which === 'draw' ? 'discard' : 'draw';
      const otherVals = p.turns.map((t) => t[which === 'draw' ? 'discard' : 'draw']);
      const flags = p.turns.map((t) => ({ tsumogiri: t.tsumogiri, riichi: t.riichi }));
      const len = Math.max(seq.length, otherVals.length);
      const next: Turn[] = [];
      for (let i = 0; i < len; i++) {
        const t: Turn = {};
        t[which] = seq[i];
        t[other] = otherVals[i];
        if (flags[i]) { t.tsumogiri = flags[i].tsumogiri; t.riichi = flags[i].riichi; }
        // auto tsumogiri when the drawn tile is the discarded tile
        if (t.draw !== undefined && t.draw === t.discard) t.tsumogiri = true;
        next.push(t);
      }
      p.turns = next;
    },
  };
}

function playerPanel(k: Kyoku, p: PlayerHand, ctx: Ctx): HTMLElement {
  const panel = el('div', { class: 'player-panel' });
  const wind = seatWind(p.seat, k.round);
  const nameInput = el('input', { class: 'name', value: p.name, onInput: (e: Event) => { p.name = (e.target as HTMLInputElement).value; ctx.refreshJson(); } });
  const startInput = el('input', { class: 'score', type: 'number', value: String(p.startScore), onInput: (e: Event) => { p.startScore = Number((e.target as HTMLInputElement).value) || 0; ctx.refreshJson(); } });
  const deltaInput = el('input', { class: 'score', type: 'number', value: String(p.scoreDelta), onInput: (e: Event) => { p.scoreDelta = Number((e.target as HTMLInputElement).value) || 0; k.result.deltas = k.players.map((pp) => pp.scoreDelta) as [number, number, number, number]; ctx.refreshJson(); } });

  panel.append(el('div', { class: 'player-head' }, [
    el('span', { class: `wind wind-${wind}` }, [wind]),
    nameInput,
    el('label', { class: 'field' }, ['start', startInput]),
    el('label', { class: 'field' }, ['Δ', deltaInput]),
  ]));

  panel.append(labeled('Haipai', tileGroup({ get: () => p.haipai, set: (t) => { p.haipai = t; }, sort: true, ctx })));

  const draws = seqAccessors(p, 'draw');
  const discards = seqAccessors(p, 'discard');
  panel.append(labeled('Draws (ツモ)', tileGroup({ get: draws.get, set: draws.set, ctx }), 'in turn order'));
  panel.append(labeled('Discards (捨牌)', tileGroup({
    get: discards.get, set: discards.set, ctx,
    chipClass: (_t, i) => p.turns[i]?.riichi ? 'riichi' : (p.turns[i]?.tsumogiri ? 'tsumogiri' : ''),
    onChip: (i) => { const t = p.turns[i]; if (t) { t.riichi = !t.riichi; ctx.rerender(); } },
  }), 'click a discard = toggle riichi'));

  // Calls.
  const callsWrap = el('div', { class: 'calls' });
  p.calls.forEach((call, ci) => {
    callsWrap.append(el('div', { class: 'call-row' }, [
      el('span', { class: 'call-type' }, [call.type]),
      ...call.tiles.map((t) => tileChip(t)),
      el('button', { class: 'mini danger', title: 'Remove', onClick: () => { p.calls.splice(ci, 1); ctx.rerender(); } }, ['×']),
    ]));
  });
  if (!p.calls.length) callsWrap.append(el('span', { class: 'muted' }, ['none']));
  panel.append(labeled('Calls', callsWrap));
  return panel;
}

export function renderKyoku(container: HTMLElement, k: Kyoku, ctx: Ctx): void {
  clear(container);

  const roundSel = el('select', { onChange: (e: Event) => { k.round = Number((e.target as HTMLSelectElement).value); ctx.rerender(); } }) as HTMLSelectElement;
  for (let r = 0; r < 16; r++) roundSel.append(el('option', { value: String(r), selected: r === k.round ? 'selected' : undefined }, [roundName(r)]));
  const honba = el('input', { type: 'number', class: 'num', value: String(k.honba), onInput: (e: Event) => { k.honba = Number((e.target as HTMLInputElement).value) || 0; ctx.refreshJson(); } });
  const sticks = el('input', { type: 'number', class: 'num', value: String(k.riichiSticks), onInput: (e: Event) => { k.riichiSticks = Number((e.target as HTMLInputElement).value) || 0; ctx.refreshJson(); } });

  container.append(el('div', { class: 'kyoku-controls' }, [
    el('label', { class: 'field' }, ['Round', roundSel]),
    el('label', { class: 'field' }, ['Honba', honba]),
    el('label', { class: 'field' }, ['Riichi sticks', sticks]),
    labeled('Dora', tileGroup({ get: () => k.doraIndicators, set: (t) => { k.doraIndicators = t; }, ctx, placeholder: '5m' })),
    labeled('Ura', tileGroup({ get: () => k.uraIndicators, set: (t) => { k.uraIndicators = t; }, ctx, placeholder: '5m' })),
  ]));

  const grid = el('div', { class: 'players-grid' });
  for (const p of k.players) grid.append(playerPanel(k, p, ctx));
  container.append(grid);

  container.append(renderResult(k, ctx));
}

function renderResult(k: Kyoku, ctx: Ctx): HTMLElement {
  const r = k.result;
  const kindSel = el('select', { onChange: (e: Event) => { r.kind = (e.target as HTMLSelectElement).value as EndKind; ctx.rerender(); } }) as HTMLSelectElement;
  for (const kind of ['ryuukyoku', 'ron', 'tsumo'] as EndKind[]) kindSel.append(el('option', { value: kind, selected: kind === r.kind ? 'selected' : undefined }, [kind]));

  const seatSel = (val: Seat | undefined, on: (s: Seat | undefined) => void) => {
    const s = el('select', { onChange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; on(v === '' ? undefined : Number(v) as Seat); ctx.refreshJson(); } }) as HTMLSelectElement;
    s.append(el('option', { value: '', selected: val === undefined ? 'selected' : undefined }, ['—']));
    for (let i = 0; i < 4; i++) s.append(el('option', { value: String(i), selected: val === i ? 'selected' : undefined }, [`P${i} (${k.players[i].name})`]));
    return s;
  };

  const box = el('div', { class: 'result-box' }, [el('span', { class: 'sub' }, ['Result']), el('label', { class: 'field' }, ['Type', kindSel])]);
  if (r.kind !== 'ryuukyoku') {
    box.append(el('label', { class: 'field' }, ['Winner', seatSel(r.winner, (s) => { r.winner = s; })]));
    if (r.kind === 'ron') box.append(el('label', { class: 'field' }, ['Deal-in', seatSel(r.loser, (s) => { r.loser = s; })]));
    box.append(el('label', { class: 'field' }, ['Win tile', el('input', { class: 'num', value: r.winningTile !== undefined ? tilesToNotation([r.winningTile]) : '', placeholder: '2m', onInput: (e: Event) => { const t = parseTileNotation((e.target as HTMLInputElement).value); r.winningTile = t[0]; ctx.refreshJson(); } })]));
  }
  box.append(el('span', { class: 'deltas' }, ['Δ ' + r.deltas.join(' / ')]));
  return box;
}
