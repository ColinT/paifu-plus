/** Replay tool: load a tenhou/6 log and step through it on the board. */

import { buildReplay } from '../replay/replay.js';
import type { ReplayGame, KyokuReplay, Step } from '../replay/replay.js';
import { renderBoardView } from './board.js';
import type { BoardView } from './board.js';
import { roundName } from './state.js';
import { tileLabel } from '../core/tileDisplay.js';
import { el, clear } from './dom.js';

interface ReplayState { game: ReplayGame | null; ky: number; step: number; playing: boolean; }

function resultTextFromLog(result: any): string | undefined {
  if (!Array.isArray(result)) return undefined;
  const kind = result[0];
  if (typeof kind === 'string' && kind.includes('流')) return 'Exhaustive draw';
  if (typeof kind === 'string' && kind.includes('和')) {
    const detail = result[2];
    if (Array.isArray(detail)) { const [who, from, , score] = detail; return who === from ? `P${who} tsumo · ${score}` : `P${who} ron off P${from} · ${score}`; }
    return 'Win';
  }
  return undefined;
}

function stepToBoardView(g: ReplayGame, k: KyokuReplay, step: Step): BoardView {
  const atEnd = step.action === 'end';
  const seats = step.players.map((p, i) => ({
    name: g.names[i] ?? `P${i + 1}`, score: p.score, riichi: p.riichi,
    hand: [...p.hand].sort((a, b) => a - b),
    river: p.river.map((r) => ({ tile: r.tile, tsumogiri: r.tsumogiri, riichi: r.riichi, called: r.called })),
    melds: p.melds.map((m) => ({ type: m.type, tiles: m.tiles, called: m.called, from: m.from })),
  })) as BoardView['seats'];
  return { round: k.round, honba: k.honba, sticks: k.sticks, dora: k.dora, ura: atEnd ? k.ura : [], seats, resultText: atEnd ? resultTextFromLog(k.result) : undefined, highlight: { seat: step.active, tile: step.tile } };
}

function stepLabel(g: ReplayGame, step: Step): string {
  const name = g.names[step.active] ?? `P${step.active + 1}`;
  const tile = step.tile !== undefined ? ` ${tileLabel(step.tile)}` : '';
  if (step.action === 'haipai') return 'Deal';
  if (step.action === 'end') return step.label + (step.tile !== undefined ? tile : '');
  return `${name}: ${step.label}${tile}`;
}

export function mountReplay(root: HTMLElement, opts: { getEditorLog: () => any }) {
  const state: ReplayState = { game: null, ky: 0, step: 0, playing: false };
  let timer: number | undefined;

  const input = el('textarea', { class: 'stream-input', spellcheck: 'false', placeholder: 'Paste a tenhou/6 JSON log here, or use “Load from editor”.' }) as HTMLTextAreaElement;
  const loadBar = el('div', { class: 'replay-load' }, [
    el('button', { class: 'btn primary', onClick: () => loadText(input.value) }, ['Load log']),
    el('button', { class: 'btn', onClick: () => { const log = opts.getEditorLog(); input.value = JSON.stringify(log); loadText(input.value); } }, ['Load from editor']),
  ]);
  const inputPanel = el('div', { class: 'stream-panel' }, [input, loadBar]);

  const tabs = el('nav', { class: 'tabs' });
  const boardEl = el('div', { class: 'board-wrap' });
  const controls = el('div', { class: 'replay-controls' });
  const view = el('div', { class: 'replay-view' }, [tabs, boardEl, controls]);

  root.append(inputPanel, view);

  function loadText(text: string) {
    let log: any;
    try { log = JSON.parse(text); } catch { alert('Not valid JSON.'); return; }
    if (!log || !Array.isArray(log.log)) { alert('Not a tenhou/6 log (missing "log" array).'); return; }
    try { state.game = buildReplay(log); } catch (e) { alert('Could not replay: ' + (e as Error).message); return; }
    state.ky = 0; state.step = 0; stop(); render();
  }

  function curKyoku(): KyokuReplay | undefined { return state.game?.kyokus[state.ky]; }

  function render() {
    inputPanel.style.display = state.game ? 'none' : 'flex';
    view.style.display = state.game ? 'block' : 'none';
    if (!state.game) return;

    clear(tabs);
    state.game.kyokus.forEach((k, i) => tabs.append(el('button', { class: `tab${i === state.ky ? ' active' : ''}`, onClick: () => { state.ky = i; state.step = 0; stop(); render(); } }, [`${roundName(k.round)}${k.honba ? `-${k.honba}` : ''}`])));
    tabs.append(el('button', { class: 'tab', onClick: () => { state.game = null; render(); } }, ['↺ new log']));

    const k = curKyoku()!;
    state.step = Math.max(0, Math.min(state.step, k.steps.length - 1));
    renderBoardView(boardEl, stepToBoardView(state.game, k, k.steps[state.step]));
    renderControls(k);
  }

  function renderControls(k: KyokuReplay) {
    clear(controls);
    const slider = el('input', { type: 'range', min: '0', max: String(k.steps.length - 1), value: String(state.step), class: 'replay-slider', onInput: (e: Event) => { state.step = Number((e.target as HTMLInputElement).value); stop(); render(); } });
    controls.append(
      el('div', { class: 'replay-buttons' }, [
        el('button', { class: 'btn', title: 'Start', onClick: () => { state.step = 0; stop(); render(); } }, ['⏮']),
        el('button', { class: 'btn', title: 'Previous', onClick: () => { state.step = Math.max(0, state.step - 1); stop(); render(); } }, ['◀']),
        el('button', { class: 'btn primary', onClick: () => (state.playing ? stop() : play()) }, [state.playing ? '⏸' : '▶']),
        el('button', { class: 'btn', title: 'Next', onClick: () => step(1) }, ['▶▎']),
        el('button', { class: 'btn', title: 'End', onClick: () => { state.step = k.steps.length - 1; stop(); render(); } }, ['⏭']),
        el('span', { class: 'replay-count' }, [`${state.step + 1} / ${k.steps.length}`]),
      ]),
      slider,
      el('div', { class: 'replay-label' }, [stepLabel(state.game!, k.steps[state.step])]),
    );
  }

  function step(delta: number) {
    const k = curKyoku(); if (!k) return;
    const nextIdx = state.step + delta;
    if (nextIdx >= k.steps.length) { stop(); return; }
    state.step = Math.max(0, nextIdx); render();
  }
  function play() { state.playing = true; render(); timer = window.setInterval(() => step(1), 700); }
  function stop() { state.playing = false; if (timer) { clearInterval(timer); timer = undefined; } }

  render();
  return { load: loadText };
}
