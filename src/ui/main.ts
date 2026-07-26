import './style.css';
import { importPdf } from '../pdf/browser.js';
import { gameToTenhou } from '../core/tenhou.js';
import { tenhouToGame } from '../core/tenhouImport.js';
import { parseStream } from '../stream/parse.js';
import type { Diagnostic } from '../stream/parse.js';
import { gameToStream } from '../stream/serialize.js';
import { newGame, gameFromKyokus, emptyKyoku, roundName } from './state.js';
import type { EditorState } from './state.js';
import { renderKyoku } from './editor.js';
import { renderBoard } from './board.js';
import { mountReplay } from './replay.js';
import { readShareFromUrl } from './share.js';
import { el, clear } from './dom.js';
import { icon } from './icon.js';

const state: EditorState & { streamText: string } = { game: newGame(), activeKyoku: 0, streamText: '' };

// ---- shell ----
const app = document.getElementById('app')!;
const toolbarEl = el('header', { class: 'toolbar' });
const panelsEl = el('div', { class: 'panels' });
const replayEl = el('div', { class: 'replay-root' });
app.append(toolbarEl, panelsEl, replayEl);

let mode: 'editor' | 'replay' = 'editor';
// Signature of the log the editor and replayer currently agree on. Guards the
// editor⇄replay sync from bouncing a log we just pushed back onto itself.
let syncedSig = '';

function setMode(m: 'editor' | 'replay') {
  mode = m;
  if (m === 'replay') syncReplayFromEditor();
  else renderAll();
  panelsEl.style.display = m === 'editor' ? 'flex' : 'none';
  replayEl.style.display = m === 'replay' ? 'block' : 'none';
  renderToolbar();
}

const replay = mountReplay(replayEl, {
  getEditorLog: () => gameToTenhou(state.game),
  // A log loaded in the replayer (paste / shared link / load-from-editor) flows
  // back into the editor so switching to Editor shows the same game.
  onLog: (log) => {
    const sig = JSON.stringify(log);
    if (sig === syncedSig) return; // this is the log we just pushed from the editor
    syncedSig = sig;
    try {
      state.game = tenhouToGame(log);
      state.activeKyoku = Math.max(0, state.game.kyokus.length - 1);
      // Populate the stream transcription with an editable rendering of the log.
      // Assigning .value directly doesn't fire 'input', so state.game (the
      // faithful decode) stays authoritative until the user actually edits.
      state.streamText = gameToStream(state.game);
      streamInput.value = state.streamText;
      clear(diagEl);
      if (mode === 'editor') renderAll();
    } catch (err) { console.warn('Could not import replay log into editor:', err); }
  },
});
replayEl.style.display = 'none';

/** Push the editor's current game into the replayer, unless it already has it. */
function syncReplayFromEditor() {
  const log = gameToTenhou(state.game);
  const sig = JSON.stringify(log);
  if (sig === syncedSig) return; // replayer already shows this game
  syncedSig = sig;
  replay.loadLog(log);
}

function panel(title: string, key: string, body: HTMLElement, opts: { collapsed?: boolean; grow?: boolean } = {}): HTMLElement {
  const sec = el('section', { class: `panel${opts.collapsed ? ' collapsed' : ''}${opts.grow ? ' grow' : ''}`, 'data-key': key });
  const toggle = el('button', { class: 'panel-toggle', onClick: () => sec.classList.toggle('collapsed') }, []);
  const head = el('div', { class: 'panel-head', onClick: (e: Event) => { if ((e.target as HTMLElement).closest('.panel-actions')) return; sec.classList.toggle('collapsed'); } }, [toggle, el('span', { class: 'panel-title' }, [title])]);
  sec.append(head, el('div', { class: 'panel-body' }, [body]));
  return sec;
}

// stream panel
const streamInput = el('textarea', { class: 'stream-input', spellcheck: 'false', placeholder: 'e1 d5m  Alice:123456789m1234z1z  Bob:…  Carol:…  Dave:…  1z  9p 8p  …' }) as HTMLTextAreaElement;
const diagEl = el('div', { class: 'diagnostics' });
const streamBody = el('div', { class: 'stream-panel' }, [streamInput, diagEl]);

// board / form / json bodies
const boardBody = el('div', { class: 'board-wrap' });
const metaEl = el('section', { class: 'meta' });
const tabsEl = el('nav', { class: 'tabs' });
const editorEl = el('main', { class: 'editor' });
const formBody = el('div', { class: 'form-wrap' }, [metaEl, tabsEl, editorEl]);
const jsonBody = el('div', { class: 'json-pane' });

panelsEl.append(
  panel('Stream transcription', 'stream', streamBody, { grow: true }),
  panel('Board', 'board', boardBody),
  panel('Form editor', 'form', formBody, { collapsed: true }),
  panel('tenhou/6 JSON', 'json', jsonBody, { collapsed: true }),
);

streamInput.addEventListener('input', () => { state.streamText = streamInput.value; parseStreamText(); });

// ---- rendering ----
function renderToolbar() {
  clear(toolbarEl);
  const fileInput = el('input', { type: 'file', accept: '.pdf', class: 'hidden', onChange: onImport }) as HTMLInputElement;
  toolbarEl.append(
    el('span', { class: 'brand' }, ['PaifuPlus']),
    el('div', { class: 'mode-toggle' }, [
      el('button', { class: `btn has-icon${mode === 'editor' ? ' primary' : ''}`, onClick: () => setMode('editor') }, [icon('edit'), 'Editor']),
      el('button', { class: `btn has-icon${mode === 'replay' ? ' primary' : ''}`, onClick: () => setMode('replay') }, [icon('play_circle'), 'Replay']),
    ]),
    el('button', { class: 'btn has-icon primary', onClick: () => fileInput.click() }, [icon('upload_file'), 'Import PAIFUN PDF']),
    fileInput,
    el('button', { class: 'btn has-icon', onClick: () => { if (confirm('Start a new empty game? Unsaved edits will be lost.')) { state.game = newGame(); state.activeKyoku = 0; state.streamText = ''; streamInput.value = ''; renderAll(); } } }, [icon('note_add'), 'New game']),
    el('span', { class: 'spacer' }),
    el('button', { class: 'btn has-icon', onClick: copyJson }, [icon('content_copy'), 'Copy JSON']),
    el('button', { class: 'btn has-icon primary', onClick: downloadJson }, [icon('download'), 'Download .json']),
    el('a', { class: 'btn link has-icon', href: 'https://tenhou.net/6/', target: '_blank', rel: 'noopener', title: 'Open the tenhou viewer, then drag the downloaded file in' }, ['Tenhou viewer', icon('open_in_new')]),
  );
}

function renderMeta() {
  clear(metaEl);
  const g = state.game.meta;
  metaEl.append(el('label', { class: 'field grow' }, ['Title', el('input', { class: 'grow', value: g.title[0] ?? '', placeholder: 'Title', onInput: (e: Event) => { g.title[0] = (e.target as HTMLInputElement).value; renderJson(); } })]));
  const names = el('div', { class: 'names' });
  for (let i = 0; i < 4; i++) names.append(el('label', { class: 'field' }, [`P${i}`, el('input', { value: g.names[i], onInput: (e: Event) => { g.names[i] = (e.target as HTMLInputElement).value; renderJson(); } })]));
  metaEl.append(names);
  const aka = el('input', { type: 'checkbox', onChange: (e: Event) => { g.rule.aka = (e.target as HTMLInputElement).checked ? 1 : 0; renderJson(); } }) as HTMLInputElement;
  aka.checked = !!g.rule.aka;
  metaEl.append(el('label', { class: 'field inline' }, [aka, 'Red fives (aka)']));
}

function deleteKyoku(i: number, label: string) {
  if (state.game.kyokus.length <= 1) return;
  if (!confirm(`Delete ${label}?`)) return;
  state.game.kyokus.splice(i, 1);
  if (state.activeKyoku > i) state.activeKyoku -= 1;
  state.activeKyoku = Math.max(0, Math.min(state.activeKyoku, state.game.kyokus.length - 1));
  renderAll();
}

function renderTabs() {
  clear(tabsEl);
  const canDelete = state.game.kyokus.length > 1;
  state.game.kyokus.forEach((k, i) => {
    const label = `${roundName(k.round)}${k.honba ? `-${k.honba}` : ''}`;
    tabsEl.append(el('div', { class: `tab kyoku${i === state.activeKyoku ? ' active' : ''}` }, [
      el('button', { class: 'tab-label', onClick: () => { state.activeKyoku = i; renderAll(); } }, [label]),
      ...(canDelete ? [el('button', { class: 'tab-del', title: `Delete ${label}`, onClick: (e: Event) => { e.stopPropagation(); deleteKyoku(i, label); } }, [icon('close')])] : []),
    ]));
  });
  tabsEl.append(el('button', { class: 'tab add', title: 'Add kyoku', onClick: () => { const last = state.game.kyokus[state.game.kyokus.length - 1]; state.game.kyokus.push(emptyKyoku(last ? Math.min(15, last.round + 1) : 0)); state.activeKyoku = state.game.kyokus.length - 1; renderAll(); } }, [icon('add')]));
}

const buildLog = () => gameToTenhou(state.game);
function renderJson() {
  clear(jsonBody);
  const head = el('div', { class: 'json-head' }, [
    el('span', {}, [`${state.game.kyokus.length} kyoku`]),
    el('button', { class: 'btn small has-icon', onClick: copyJson }, [icon('content_copy'), 'Copy']),
  ]);
  jsonBody.append(head, el('pre', { class: 'json' }, [JSON.stringify(buildLog(), null, 1)]));
}
function renderBoardPanel() { renderBoard(boardBody, state.game.kyokus[state.activeKyoku]); }
function renderForm() { renderMeta(); renderTabs(); const k = state.game.kyokus[state.activeKyoku]; if (k) renderKyoku(editorEl, k, { rerender: renderAll, refreshJson: renderJson }); else clear(editorEl); }

/** Full refresh of the derived views (not the stream textarea). */
function renderAll() { renderToolbar(); renderForm(); renderBoardPanel(); renderJson(); }

function renderDiagnostics(diags: Diagnostic[], missing: number) {
  clear(diagEl);
  if (!diags.length) { diagEl.append(el('span', { class: 'diag-ok' }, [state.streamText.trim() ? '✓ no issues' : ''])); return; }
  const errs = diags.filter((d) => d.severity === 'error').length;
  const warns = diags.filter((d) => d.severity === 'warn').length;
  diagEl.append(el('div', { class: 'diag-summary' }, [`${errs} error${errs === 1 ? '' : 's'}, ${warns} warning${warns === 1 ? '' : 's'}${missing ? `, ${missing} missed (?)` : ''}`]));
  const list = el('div', { class: 'diag-list' });
  for (const d of diags.slice(0, 40)) {
    const snippet = state.streamText.slice(d.start, d.end);
    list.append(el('div', { class: `diag ${d.severity}`, onClick: () => { streamInput.focus(); streamInput.setSelectionRange(d.start, d.end); } }, [el('code', {}, [snippet || '·']), ' ', d.message]));
  }
  diagEl.append(list);
}

function parseStreamText() {
  const { game, diagnostics, missing } = parseStream(state.streamText);
  if (game.kyokus.length) { state.game = game; state.activeKyoku = game.kyokus.length - 1; }
  renderForm(); renderBoardPanel(); renderJson();
  renderDiagnostics(diagnostics, missing);
}

// ---- import / export ----
async function onImport(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    const { kyokus, errors } = await importPdf(await file.arrayBuffer());
    state.game = gameFromKyokus(kyokus, file.name.replace(/\.pdf$/i, ''));
    state.activeKyoku = 0; renderAll();
    if (errors.length) alert(`Imported ${kyokus.length} kyoku. ${errors.length} page(s) failed:\n` + errors.map((x) => `  p${x.page}: ${x.message}`).join('\n'));
  } catch (err) { alert('Import failed: ' + (err as Error).message); }
  (e.target as HTMLInputElement).value = '';
}

const jsonText = () => JSON.stringify(buildLog());
async function copyJson() { try { await navigator.clipboard.writeText(jsonText()); flash('Copied JSON'); } catch { alert('Copy failed — use Download.'); } }
function downloadJson() {
  const blob = new Blob([jsonText()], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: (state.game.meta.title[0] || 'paifu').replace(/\s+/g, '_') + '.json' });
  document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}
function flash(msg: string) { const f = el('div', { class: 'flash' }, [msg]); document.body.append(f); setTimeout(() => f.remove(), 1600); }

renderAll();

// A shared link (#replay=...) opens straight into the replayer.
const shared = readShareFromUrl();
if (shared) { setMode('replay'); replay.loadShared(shared); }
