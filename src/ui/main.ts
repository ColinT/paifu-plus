import './style.css';
import { importPdf, readEmbeddedLog } from '../pdf/browser.js';
import { gameToPaifuPdf } from '../pdf/paifu.js';
import { gameToTenhou, tenhouCompatible, hasNonTenhouTiles } from '../core/tenhou.js';
import { tenhouToGame } from '../core/tenhouImport.js';
import type { Game } from '../core/model.js';
import { openDialog } from './dialog.js';
import { parseStream } from '../stream/parse.js';
import type { Diagnostic } from '../stream/parse.js';
import { gameToStream } from '../stream/serialize.js';
import { spliceRoundHeader } from '../stream/header.js';
import { tilesToNotation } from '../core/tiles.js';
import { newGame, gameFromKyokus, emptyKyoku, roundName } from './state.js';
import type { EditorState } from './state.js';
import { renderKyoku } from './editor.js';
import { renderBoard } from './board.js';
import { mountReplay } from './replay.js';
import { readShareFromUrl } from './share.js';
import { el, clear } from './dom.js';
import { icon } from './icon.js';

const state: EditorState & { streamText: string } = { game: newGame(), activeKyoku: 0, streamText: '' };

// A quick-edit (name/haipai/dora/ura) typed before its round token exists has
// nothing to anchor to; it's held here and flushed once the round is entered.
// While pending, the fields hold unsaved input and must not be repopulated.
let pendingQuickEdit = false;

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
      pendingQuickEdit = false; // fresh log — quick fields reflect it
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

// Quick-edit row: fill in the current hand's dora indicator and each haipai
// later (e.g. during a pause), splicing into the raw stream without touching the
// live play tokens. Fields reflect the active kyoku and edit it in place.
const WINDS = ['E', 'S', 'W', 'N'];
const isDefaultName = (n: string) => !n || /^Player \d$/.test(n);
const doraField = el('input', { class: 'q-in', spellcheck: 'false', placeholder: 'dora 6p', title: 'Dora indicator — the dead-wall tile (0p = red 5p)' }) as HTMLInputElement;
const uraField = el('input', { class: 'q-in', spellcheck: 'false', placeholder: 'ura 3s', title: 'Ura-dora indicator(s), revealed under a riichi win' }) as HTMLInputElement;
const nameFields: HTMLInputElement[] = [];
const haipaiFields: HTMLInputElement[] = [];
// First column holds the dora indicator (aligned with the name row) and the ura
// indicator below it (aligned with the haipai row); each seat column is wind /
// name / haipai, so the fields line up across.
const quickRow = el('div', { class: 'stream-quick' }, [
  el('div', { class: 'q-field' }, [el('span', { class: 'q-lbl' }, ['Dora / Ura']), doraField, uraField]),
]);
for (let s = 0; s < 4; s++) {
  const nameInp = el('input', { class: 'q-in q-name', spellcheck: 'false', placeholder: 'name' }) as HTMLInputElement;
  const inp = el('input', { class: 'q-in q-hp', spellcheck: 'false', placeholder: 'haipai' }) as HTMLInputElement;
  nameFields.push(nameInp); haipaiFields.push(inp);
  quickRow.append(el('div', { class: 'q-field' }, [el('span', { class: 'q-lbl' }, [WINDS[s]]), nameInp, inp]));
}
const streamBody = el('div', { class: 'stream-panel' }, [quickRow, streamInput, diagEl]);

/** Mirror the active kyoku's dora, names and haipai into the quick-edit fields. */
function populateQuickFields() {
  if (pendingQuickEdit) return; // fields hold unsaved input — don't clobber it
  const k = state.game.kyokus[state.activeKyoku];
  if (!k) { doraField.value = ''; uraField.value = ''; nameFields.forEach((f) => (f.value = '')); haipaiFields.forEach((f) => (f.value = '')); return; }
  doraField.value = tilesToNotation(k.doraIndicators);
  uraField.value = tilesToNotation(k.uraIndicators);
  for (let s = 0; s < 4; s++) {
    const p = k.players[(k.round + s) % 4];
    const tiles = s === 0 && p.turns[0]?.draw !== undefined ? [...p.haipai, p.turns[0].draw] : p.haipai;
    haipaiFields[s].value = tilesToNotation(tiles);
    nameFields[s].value = isDefaultName(p.name) ? '' : p.name;
  }
}

const quickFieldValues = () => ({ dora: doraField.value, ura: uraField.value, haipai: haipaiFields.map((f) => f.value), names: nameFields.map((f) => f.value) });
const isRoundTok = (t: string) => /^[eswn][1-4]([._\-][0-9]+){0,2}$/i.test(t);
const hasRoundFor = (text: string, idx: number) => text.split(/[\s,]+/).filter(isRoundTok).length > idx;

/** A quick-field edit: splice the new dora / ura / names / haipai into the stream. */
function onQuickEdit() {
  const edit = quickFieldValues();
  if (!hasRoundFor(state.streamText, state.activeKyoku)) {
    pendingQuickEdit = !!(edit.dora || edit.ura || edit.haipai.some(Boolean) || edit.names.some(Boolean));
    return; // no round yet — keep the field values and wait for it
  }
  pendingQuickEdit = false;
  const text = spliceRoundHeader(state.streamText, state.activeKyoku, edit);
  state.streamText = text; streamInput.value = text;
  const idx = state.activeKyoku;
  const { game, diagnostics, missing } = parseStream(text);
  if (game.kyokus.length) { state.game = game; state.activeKyoku = Math.min(idx, game.kyokus.length - 1); }
  renderForm(); renderBoardPanel(); renderJson(); renderDiagnostics(diagnostics, missing);
}
[doraField, uraField, ...nameFields, ...haipaiFields].forEach((f) => f.addEventListener('input', onQuickEdit));

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
  toolbarEl.append(
    el('span', { class: 'brand' }, ['PaifuPlus']),
    el('div', { class: 'mode-toggle' }, [
      el('button', { class: `btn has-icon${mode === 'editor' ? ' primary' : ''}`, onClick: () => setMode('editor') }, [icon('edit'), 'Editor']),
      el('button', { class: `btn has-icon${mode === 'replay' ? ' primary' : ''}`, onClick: () => setMode('replay') }, [icon('play_circle'), 'Replay']),
    ]),
    el('span', { class: 'spacer' }),
    el('button', { class: 'btn has-icon', onClick: openImportDialog }, [icon('upload_file'), 'Import']),
    el('button', { class: 'btn has-icon primary', onClick: openExportDialog }, [icon('download'), 'Export']),
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

// tenhou-JSON surfaces (panel, download, copy, viewer) strip arbitrary aka,
// which tenhou can't represent. Native surfaces (share, PDF embed, replay
// sync via getEditorLog) keep the faithful gameToTenhou(state.game).
const buildLog = () => gameToTenhou(tenhouCompatible(state.game));
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
function renderAll() { renderToolbar(); renderForm(); renderBoardPanel(); renderJson(); populateQuickFields(); }

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
  let { game, diagnostics, missing } = parseStream(state.streamText);
  if (game.kyokus.length) { state.game = game; state.activeKyoku = game.kyokus.length - 1; }
  // Flush a quick-edit that couldn't anchor earlier, now that a round exists.
  if (pendingQuickEdit && hasRoundFor(state.streamText, state.activeKyoku)) {
    const text = spliceRoundHeader(state.streamText, state.activeKyoku, quickFieldValues());
    if (text !== state.streamText) {
      state.streamText = text; streamInput.value = text;
      const r = parseStream(text);
      if (r.game.kyokus.length) { state.game = r.game; state.activeKyoku = r.game.kyokus.length - 1; }
      diagnostics = r.diagnostics; missing = r.missing;
    }
    pendingQuickEdit = false;
  }
  renderForm(); renderBoardPanel(); renderJson();
  renderDiagnostics(diagnostics, missing);
  populateQuickFields();
}

// ---- import / export ----

/** Adopt an imported game: update the model, refresh the editable stream, render. */
function loadGame(game: Game) {
  state.game = game;
  state.activeKyoku = 0;
  pendingQuickEdit = false;
  try { state.streamText = gameToStream(game); } catch { state.streamText = ''; }
  streamInput.value = state.streamText;
  clear(diagEl);
  renderAll();
}

const isPdfBytes = (buf: ArrayBuffer) => new TextDecoder().decode(new Uint8Array(buf, 0, 5)) === '%PDF-';
const baseName = () => (state.game.meta.title[0] || 'paifu').replace(/\s+/g, '_');

function openImportDialog() {
  const fileInput = el('input', { type: 'file', accept: '.pdf,.json,application/json,application/pdf', class: 'hidden', onChange: (e: Event) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) void handleFile(f); } }) as HTMLInputElement;
  const drop = el('div', { class: 'dropzone', onClick: () => fileInput.click() }, [
    icon('upload_file'), el('div', { class: 'dz-main' }, ['Drag & drop a Paifun PDF or Tenhou JSON']), el('div', { class: 'muted' }, ['or click to browse']),
  ]);
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); const f = (e as DragEvent).dataTransfer?.files?.[0]; if (f) void handleFile(f); });

  const paste = el('textarea', { class: 'paste-json', spellcheck: 'false', placeholder: '…or paste Tenhou/6 JSON here' }) as HTMLTextAreaElement;
  const dlg = openDialog({
    title: 'Import',
    body: [
      el('div', { class: 'import-formats' }, ['Supports ', el('b', {}, ['Paifun PDF']), ', ', el('b', {}, ['Tenhou JSON']), ', and PaifuPlus PDFs.']),
      drop, fileInput,
      el('div', { class: 'dialog-or' }, ['or paste JSON']),
      paste,
      el('div', { class: 'dialog-actions' }, [el('button', { class: 'btn primary', onClick: () => importJsonText(paste.value) }, ['Import JSON'])]),
    ],
  });

  async function handleFile(f: File) {
    try {
      const buf = await f.arrayBuffer();
      if (/\.pdf$/i.test(f.name) || isPdfBytes(buf)) {
        const embedded = await readEmbeddedLog(buf);
        if (embedded) { loadGame(tenhouToGame(embedded)); flash('Imported PaifuPlus PDF'); dlg.close(); return; }
        const { kyokus, errors } = await importPdf(buf);
        if (!kyokus.length) { alert('No hands found in that PDF.'); return; }
        loadGame(gameFromKyokus(kyokus, f.name.replace(/\.pdf$/i, '')));
        dlg.close();
        if (errors.length) alert(`Imported ${kyokus.length} kyoku. ${errors.length} page(s) failed:\n` + errors.map((x) => `  p${x.page}: ${x.message}`).join('\n'));
      } else {
        importJsonText(new TextDecoder().decode(buf));
      }
    } catch (err) { alert('Import failed: ' + (err as Error).message); }
  }

  function importJsonText(text: string) {
    if (!text.trim()) { alert('Paste a Tenhou/6 JSON log first.'); return; }
    let log: any;
    try { log = JSON.parse(text); } catch { alert('Not valid JSON.'); return; }
    if (!log || !Array.isArray(log.log)) { alert('Not a tenhou/6 log (missing "log" array).'); return; }
    loadGame(tenhouToGame(log));
    flash('Imported Tenhou JSON');
    dlg.close();
  }
}

function openExportDialog() {
  const warning = hasNonTenhouTiles(state.game)
    ? [el('div', { class: 'dialog-warning' }, [icon('warning'), el('span', {}, ['This record has aka dora on non-five tiles, which tenhou’s format can’t represent. They export as plain tiles in the Tenhou JSON and viewer — the PDF and PaifuPlus share links keep them.'])])]
    : [];
  openDialog({
    title: 'Export',
    body: [
      ...warning,
      el('div', { class: 'export-row' }, [
        el('button', { class: 'btn has-icon primary', onClick: () => exportPdf('en') }, [icon('download'), 'Paifu PDF (English)']),
        el('button', { class: 'btn has-icon primary', onClick: () => exportPdf('ja') }, [icon('download'), 'Paifu PDF (日本語)']),
      ]),
      el('div', { class: 'export-row' }, [el('span', { class: 'muted' }, ['PAIFUN-style paifu, rendered by PaifuPlus — re-importable'])]),
      el('div', { class: 'export-row' }, [
        el('button', { class: 'btn has-icon', onClick: () => { downloadJson(); flash('Downloaded JSON'); } }, [icon('download'), 'Download Tenhou JSON']),
        el('button', { class: 'btn has-icon', onClick: copyJson }, [icon('content_copy'), 'Copy JSON']),
      ]),
      el('div', { class: 'export-row' }, [
        el('button', { class: 'btn has-icon', onClick: openInTenhou }, [icon('open_in_new'), 'Open in Tenhou viewer']),
      ]),
    ],
  });
}

/** Open the current log in tenhou's online viewer (data rides in the URL fragment). */
function openInTenhou() {
  const url = 'https://tenhou.net/5/#json=' + encodeURIComponent(jsonText());
  window.open(url, '_blank', 'noopener');
}

async function exportPdf(lang: 'en' | 'ja') {
  try {
    const bytes = await gameToPaifuPdf(state.game, lang);
    downloadBlob(new Blob([bytes as BlobPart], { type: 'application/pdf' }), `${baseName()}_${lang}.pdf`);
    flash('Downloaded PDF');
  } catch (err) { alert('PDF export failed: ' + (err as Error).message); }
}

const jsonText = () => JSON.stringify(buildLog());
async function copyJson() { try { await navigator.clipboard.writeText(jsonText()); flash('Copied JSON'); } catch { alert('Copy failed — use Download.'); } }
function downloadJson() { downloadBlob(new Blob([jsonText()], { type: 'application/json' }), baseName() + '.json'); }
function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}
function flash(msg: string) { const f = el('div', { class: 'flash' }, [msg]); document.body.append(f); setTimeout(() => f.remove(), 1600); }

renderAll();

// A shared link (#replay=...) opens straight into the replayer.
const shared = readShareFromUrl();
if (shared) { setMode('replay'); replay.loadShared(shared); }
