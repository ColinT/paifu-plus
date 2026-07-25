import './style.css';
import { importPdf } from '../pdf/browser.js';
import { gameToTenhou } from '../core/tenhou.js';
import { newGame, gameFromKyokus, emptyKyoku, roundName } from './state.js';
import type { EditorState } from './state.js';
import { renderKyoku } from './editor.js';
import { el, clear } from './dom.js';

const state: EditorState = { game: newGame(), activeKyoku: 0 };

const app = document.getElementById('app')!;
app.append(
  el('header', { class: 'toolbar' }),
  el('section', { class: 'meta' }),
  el('nav', { class: 'tabs' }),
  el('main', { class: 'editor' }),
  el('aside', { class: 'json-pane' }),
);
const toolbarEl = app.querySelector('.toolbar') as HTMLElement;
const metaEl = app.querySelector('.meta') as HTMLElement;
const tabsEl = app.querySelector('.tabs') as HTMLElement;
const editorEl = app.querySelector('.editor') as HTMLElement;
const jsonEl = app.querySelector('.json-pane') as HTMLElement;

function render() {
  renderToolbar();
  renderMeta();
  renderTabs();
  const k = state.game.kyokus[state.activeKyoku];
  if (k) renderKyoku(editorEl, k, { rerender: render, refreshJson: renderJson });
  else clear(editorEl);
  renderJson();
}

function renderToolbar() {
  clear(toolbarEl);
  const fileInput = el('input', { type: 'file', accept: '.pdf', class: 'hidden', onChange: onImport }) as HTMLInputElement;
  toolbarEl.append(
    el('span', { class: 'brand' }, ['牌譜 → tenhou']),
    el('button', { class: 'btn primary', onClick: () => fileInput.click() }, ['Import PAIFUN PDF']),
    fileInput,
    el('button', { class: 'btn', onClick: () => { if (confirm('Start a new empty game? Unsaved edits will be lost.')) { state.game = newGame(); state.activeKyoku = 0; render(); } } }, ['New game']),
    el('span', { class: 'spacer' }),
    el('button', { class: 'btn', onClick: copyJson }, ['Copy JSON']),
    el('button', { class: 'btn primary', onClick: downloadJson }, ['Download .json']),
    el('a', { class: 'btn link', href: 'https://tenhou.net/6/', target: '_blank', rel: 'noopener', title: 'Open tenhou viewer, then drag the downloaded file in' }, ['Tenhou viewer ↗']),
  );
}

function renderMeta() {
  clear(metaEl);
  const g = state.game.meta;
  const title = el('input', { class: 'grow', value: g.title[0] ?? '', placeholder: 'Title', onInput: (e: Event) => { g.title[0] = (e.target as HTMLInputElement).value; renderJson(); } });
  metaEl.append(el('label', { class: 'field grow' }, ['Title', title]));
  const names = el('div', { class: 'names' });
  for (let i = 0; i < 4; i++) {
    names.append(el('label', { class: 'field' }, [`P${i}`, el('input', { value: g.names[i], onInput: (e: Event) => { g.names[i] = (e.target as HTMLInputElement).value; renderJson(); } })]));
  }
  metaEl.append(names);
  const aka = el('input', { type: 'checkbox', onChange: (e: Event) => { g.rule.aka = (e.target as HTMLInputElement).checked ? 1 : 0; renderJson(); } }) as HTMLInputElement;
  aka.checked = !!g.rule.aka;
  metaEl.append(el('label', { class: 'field inline' }, [aka, 'Red fives (aka)']));
}

function renderTabs() {
  clear(tabsEl);
  state.game.kyokus.forEach((k, i) => {
    tabsEl.append(el('button', { class: `tab${i === state.activeKyoku ? ' active' : ''}`, onClick: () => { state.activeKyoku = i; render(); } }, [
      `${roundName(k.round)}${k.honba ? `-${k.honba}` : ''}`,
    ]));
  });
  tabsEl.append(el('button', { class: 'tab add', title: 'Add kyoku', onClick: () => {
    const last = state.game.kyokus[state.game.kyokus.length - 1];
    state.game.kyokus.push(emptyKyoku(last ? Math.min(15, last.round + 1) : 0));
    state.activeKyoku = state.game.kyokus.length - 1; render();
  } }, ['+']));
  if (state.game.kyokus.length > 1) {
    tabsEl.append(el('button', { class: 'tab del', title: 'Delete this kyoku', onClick: () => {
      state.game.kyokus.splice(state.activeKyoku, 1);
      state.activeKyoku = Math.max(0, state.activeKyoku - 1); render();
    } }, ['🗑']));
  }
}

function buildLog() { return gameToTenhou(state.game); }

function renderJson() {
  clear(jsonEl);
  const log = buildLog();
  jsonEl.append(
    el('div', { class: 'json-head' }, [`tenhou/6 JSON — ${state.game.kyokus.length} kyoku`]),
    el('pre', { class: 'json' }, [JSON.stringify(log, null, 1)]),
  );
}

async function onImport(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const banner = el('div', { class: 'banner' }, [`Importing ${file.name}…`]);
  metaEl.prepend(banner);
  try {
    const { kyokus, errors } = await importPdf(await file.arrayBuffer());
    state.game = gameFromKyokus(kyokus, file.name.replace(/\.pdf$/i, ''));
    state.activeKyoku = 0;
    render();
    if (errors.length) alert(`Imported ${kyokus.length} kyoku. ${errors.length} page(s) could not be parsed:\n` + errors.map((x) => `  p${x.page}: ${x.message}`).join('\n'));
  } catch (err) {
    alert('Import failed: ' + (err as Error).message);
    banner.remove();
  }
  (e.target as HTMLInputElement).value = '';
}

function jsonText() { return JSON.stringify(buildLog()); }
async function copyJson() {
  try { await navigator.clipboard.writeText(jsonText()); flash('Copied JSON to clipboard'); }
  catch { alert('Copy failed — use Download instead.'); }
}
function downloadJson() {
  const blob = new Blob([jsonText()], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: (state.game.meta.title[0] || 'paifu').replace(/\s+/g, '_') + '.json' });
  document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}
function flash(msg: string) {
  const f = el('div', { class: 'flash' }, [msg]);
  document.body.append(f);
  setTimeout(() => f.remove(), 1800);
}

render();
