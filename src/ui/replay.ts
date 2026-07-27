/** Replay tool: load a tenhou/6 log and step through it on the board. */

import { buildReplay } from '../replay/replay.js';
import type { ReplayGame, KyokuReplay, Step } from '../replay/replay.js';
import { renderBoardView, scoreEnglish } from './board.js';
import type { BoardView, BoardResult } from './board.js';
import { tileImg } from './tileEl.js';
import { compareTiles } from '../core/tiles.js';
import { el, clear } from './dom.js';
import { icon } from './icon.js';
import { logId, loadComments, saveComments, shareUrl } from './share.js';
import type { Comment, SharePayload } from './share.js';

interface ReplayState {
  game: ReplayGame | null; ky: number; step: number; playing: boolean;
  log: unknown; id: string; comments: Comment[];
}

function resultFromLog(result: any, step: Step): BoardResult | undefined {
  if (!Array.isArray(result)) return undefined;
  const kind = String(result[0] ?? '');
  if (kind.includes('流')) return { kind: 'ryuukyoku', winners: [] };
  if (!kind.includes('和')) return undefined;
  // One (deltas, detail) pair per winning hand; details sit at indices 2, 4, …
  const details = result.filter((_: unknown, i: number) => i >= 2 && i % 2 === 0 && Array.isArray(result[i])) as any[][];
  if (!details.length) return undefined;
  const from = Number(details[0][1]);
  const isTsumo = Number(details[0][0]) === from;
  const winners = details.map((d) => ({ seat: Number(d[0]), scoreEn: scoreEnglish(typeof d[3] === 'string' ? d[3] : undefined) }));
  const winningTile = isTsumo
    ? (step.tile ?? step.players[Number(details[0][0])]?.drawn ?? undefined)
    : step.players[from]?.river.at(-1)?.tile;
  return { kind: isTsumo ? 'tsumo' : 'ron', winners, loser: isTsumo ? undefined : from, winningTile: winningTile ?? undefined };
}

function stepToBoardView(g: ReplayGame, k: KyokuReplay, step: Step): BoardView {
  const atEnd = step.action === 'end';
  const seats = step.players.map((p, i) => {
    const hand = [...p.hand].sort(compareTiles);
    let drawn: number | undefined;
    if (p.drawn !== null) { drawn = p.drawn; const idx = hand.indexOf(p.drawn); if (idx >= 0) hand.splice(idx, 1); }
    return {
      name: g.names[i] ?? `P${i + 1}`, score: p.score, riichi: p.riichi, hand, drawn,
      river: p.river.map((r) => ({ tile: r.tile, tsumogiri: r.tsumogiri, riichi: r.riichi, called: r.called })),
      melds: p.melds.map((m) => ({ type: m.type, tiles: m.tiles, called: m.called, from: m.from })),
    };
  }) as BoardView['seats'];
  return { round: k.round, honba: k.honba, sticks: k.sticks, dora: k.dora, ura: atEnd ? k.ura : [], seats, result: atEnd ? resultFromLog(k.result, step) : undefined, highlight: { seat: step.active, tile: step.tile }, title: g.title };
}

function stepLabel(g: ReplayGame, step: Step): (Node | string)[] {
  const name = g.names[step.active] ?? `P${step.active + 1}`;
  const tile = step.tile !== undefined ? [tileImg(step.tile, 'label-tile')] : [];
  if (step.action === 'haipai') return ['Deal'];
  if (step.action === 'end') return [step.label, ...tile];
  return [`${name}: ${step.label}`, ...tile];
}

export function mountReplay(root: HTMLElement, opts: { getEditorLog: () => any; onLog?: (log: any) => void; onRoundChange?: (ky: number) => void }) {
  const state: ReplayState = { game: null, ky: 0, step: 0, playing: false, log: null, id: '', comments: [] };
  let timer: number | undefined;

  // Round navigation lives in the shared round bar (main.ts); loading logs goes
  // through the toolbar Import. So the replay screen is just board + controls.
  const boardEl = el('div', { class: 'board-wrap' });
  const controls = el('div', { class: 'replay-controls' });
  const view = el('div', { class: 'replay-view' }, [boardEl, controls]);

  root.append(view);

  // Close the Share dropdown when clicking outside it.
  document.addEventListener('click', (e) => {
    const dd = controls.querySelector('.share-dd') as HTMLDetailsElement | null;
    if (dd?.open && !dd.contains(e.target as Node)) dd.open = false;
  });

  function loadLog(log: any, extraComments?: Comment[]) {
    if (!log || !Array.isArray(log.log)) { alert('Not a tenhou/6 log (missing "log" array).'); return; }
    try { state.game = buildReplay(log); } catch (e) { alert('Could not replay: ' + (e as Error).message); return; }
    state.log = log; state.id = logId(log);
    state.comments = loadComments(state.id);
    // merge any comments arriving from a shared link (dedup by ky/step/text)
    for (const c of extraComments ?? []) {
      if (!state.comments.some((x) => x.ky === c.ky && x.step === c.step && x.text === c.text)) state.comments.push(c);
    }
    if (extraComments?.length) saveComments(state.id, state.comments);
    state.ky = 0; state.step = 0; stop(); render();
    opts.onLog?.(log);
  }
  function loadShared(payload: SharePayload) {
    loadLog(payload.log, payload.comments);
    if (payload.pos && state.game) {
      state.ky = Math.max(0, Math.min(payload.pos.ky, state.game.kyokus.length - 1));
      state.step = Math.max(0, payload.pos.step);
      stop(); render(); // render clamps step to the kyoku length
    }
  }

  const commentsAt = (ky: number, step: number) => state.comments.filter((c) => c.ky === ky && c.step === step);
  function addComment(text: string) {
    if (!text.trim()) return;
    state.comments.push({ ky: state.ky, step: state.step, text: text.trim() });
    saveComments(state.id, state.comments);
    render();
  }
  function removeComment(c: Comment) {
    const i = state.comments.indexOf(c); if (i >= 0) state.comments.splice(i, 1);
    saveComments(state.id, state.comments); render();
  }
  function gotoComment(dir: 1 | -1) {
    const marks = state.comments.filter((c) => c.ky === state.ky).map((c) => c.step).sort((a, b) => a - b);
    const target = dir > 0 ? marks.find((s) => s > state.step) : [...marks].reverse().find((s) => s < state.step);
    if (target !== undefined) { state.step = target; stop(); render(); }
  }

  function curKyoku(): KyokuReplay | undefined { return state.game?.kyokus[state.ky]; }

  function render() {
    if (!state.game) { clear(boardEl); clear(controls); return; }
    const k = curKyoku()!;
    state.step = Math.max(0, Math.min(state.step, k.steps.length - 1));
    renderBoardView(boardEl, stepToBoardView(state.game, k, k.steps[state.step]));
    renderControls(k);
    opts.onRoundChange?.(state.ky);   // keep the shared round bar in sync
  }

  function renderControls(k: KyokuReplay) {
    clear(controls);
    const slider = el('input', { type: 'range', min: '0', max: String(k.steps.length - 1), value: String(state.step), class: 'replay-slider', onInput: (e: Event) => { state.step = Number((e.target as HTMLInputElement).value); stop(); render(); } });
    const commentCount = state.comments.filter((c) => c.ky === state.ky).length;
    controls.append(
      el('div', { class: 'replay-buttons' }, [
        el('button', { class: 'btn icon', title: 'Start', onClick: () => { state.step = 0; stop(); render(); } }, [icon('first_page')]),
        el('button', { class: 'btn icon', title: 'Previous', onClick: () => { state.step = Math.max(0, state.step - 1); stop(); render(); } }, [icon('navigate_before')]),
        el('button', { class: 'btn primary icon', title: state.playing ? 'Pause' : 'Play', onClick: () => (state.playing ? stop() : play()) }, [icon(state.playing ? 'pause' : 'play_arrow')]),
        el('button', { class: 'btn icon', title: 'Next', onClick: () => step(1) }, [icon('navigate_next')]),
        el('button', { class: 'btn icon', title: 'End', onClick: () => { state.step = k.steps.length - 1; stop(); render(); } }, [icon('last_page')]),
        el('span', { class: 'replay-count' }, [stepInput(k), ` / ${k.steps.length}`]),
        el('span', { class: 'spacer' }),
        el('button', { class: 'btn icon', title: 'Previous comment', onClick: () => gotoComment(-1) }, [icon('navigate_before'), icon('chat_bubble')]),
        el('button', { class: 'btn icon', title: 'Next comment', onClick: () => gotoComment(1) }, [icon('chat_bubble'), icon('navigate_next'), ...(commentCount ? [el('span', { class: 'badge' }, [String(commentCount)])] : [])]),
        shareDropdown(),
      ]),
      slider,
      el('div', { class: 'replay-label' }, stepLabel(state.game!, k.steps[state.step])),
      renderComments(),
    );
  }

  function renderComments(): HTMLElement {
    const box = el('div', { class: 'comments' });
    const here = commentsAt(state.ky, state.step);
    for (const c of here) {
      box.append(el('div', { class: 'comment' }, [el('span', { class: 'comment-text' }, [c.text]), el('button', { class: 'mini danger', title: 'Delete', onClick: () => removeComment(c) }, ['×'])]));
    }
    const inp = el('input', { class: 'field-control comment-input', placeholder: 'Add a comment at this move…', onKeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') { addComment((e.target as HTMLInputElement).value); } } }) as HTMLInputElement;
    box.append(el('div', { class: 'comment-add' }, [inp, el('button', { class: 'btn small', onClick: () => addComment(inp.value) }, ['Add'])]));
    return box;
  }

  /** Editable step number (1-indexed); jump on Enter/blur. */
  function stepInput(k: KyokuReplay): HTMLInputElement {
    const inp = el('input', {
      type: 'number', min: '1', max: String(k.steps.length), value: String(state.step + 1), class: 'field-control step-input',
      title: 'Jump to step', onFocus: (e: Event) => (e.target as HTMLInputElement).select(),
      onChange: (e: Event) => {
        const v = Number((e.target as HTMLInputElement).value);
        if (Number.isFinite(v)) { state.step = Math.max(0, Math.min(v - 1, k.steps.length - 1)); stop(); render(); }
      },
    }) as HTMLInputElement;
    return inp;
  }

  function shareDropdown(): HTMLElement {
    const dd = el('details', { class: 'share-dd' }, [
      el('summary', { class: 'btn has-icon', title: 'Copy a shareable link (log + comments)' }, [icon('share'), 'Share']),
      el('div', { class: 'share-menu' }, [
        el('button', { class: 'menu-item', onClick: () => { copyShare(false); (dd as HTMLDetailsElement).open = false; } }, [icon('share'), 'Copy link (from the start)']),
        el('button', { class: 'menu-item', onClick: () => { copyShare(true); (dd as HTMLDetailsElement).open = false; } }, [icon('share'), `Copy link to step ${state.step + 1}`]),
      ]),
    ]);
    return dd;
  }

  async function copyShare(atStep: boolean) {
    const payload = { log: state.log, comments: state.comments, ...(atStep ? { pos: { ky: state.ky, step: state.step } } : {}) };
    const url = shareUrl(payload);
    try { await navigator.clipboard.writeText(url); flash(atStep ? `Link to step ${state.step + 1} copied` : 'Share link copied'); }
    catch { prompt('Copy this share link:', url); }
  }
  function flash(msg: string) { const f = el('div', { class: 'flash' }, [msg]); document.body.append(f); setTimeout(() => f.remove(), 1600); }

  function step(delta: number) {
    const k = curKyoku(); if (!k) return;
    const nextIdx = state.step + delta;
    if (nextIdx >= k.steps.length) { stop(); return; }
    state.step = Math.max(0, nextIdx); render();
  }
  function play() { state.playing = true; render(); timer = window.setInterval(() => step(1), 700); }
  function stop() { state.playing = false; if (timer) { clearInterval(timer); timer = undefined; } }

  render();
  return {
    loadShared, loadLog,
    currentKyoku: () => state.ky,
    showKyoku: (i: number) => {
      if (!state.game) return;
      state.ky = Math.max(0, Math.min(i, state.game.kyokus.length - 1));
      state.step = 0; stop(); render();
    },
  };
}
