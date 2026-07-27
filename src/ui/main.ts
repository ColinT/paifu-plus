import './style.css';
import { importPdf, readEmbeddedLog } from '../pdf/browser.js';
import { gameToPaifuPdf } from '../pdf/paifu.js';
import { gameToTenhou, tenhouCompatible, hasNonTenhouTiles } from '../core/tenhou.js';
import { tenhouToGame } from '../core/tenhouImport.js';
import type { Game, Kyoku } from '../core/model.js';
import { openDialog } from './dialog.js';
import { parseStream } from '../stream/parse.js';
import type { Diagnostic } from '../stream/parse.js';
import { gameToStream } from '../stream/serialize.js';
import { spliceRoundHeader, readHaipai, roundRegions } from '../stream/header.js';
import { applyCarryOver } from '../stream/carryover.js';
import type { CarryConflict } from '../stream/carryover.js';
import { tilesToNotation } from '../core/tiles.js';
import { newGame, gameFromKyokus, roundName, emptyKyoku } from './state.js';
import type { EditorState } from './state.js';
import { renderKyoku } from './editor.js';
import { renderBoard } from './board.js';
import { mountReplay } from './replay.js';
import { readShareFromUrl } from './share.js';
import { listSaves, readSave, writeSave, deleteSave, makeSave } from './storage.js';
import type { SaveMeta } from './storage.js';
import { el, clear } from './dom.js';
import { icon } from './icon.js';

// One editable DSL text per round (a positional slot). The textarea edits the
// active slot; a slot survives even when its text has no round token yet — so
// clearing "e2" to retype it as another round doesn't delete the tab. The game
// model is kept 1:1 with the slots (a tokenless slot becomes a placeholder), so
// activeKyoku indexes both. state.game stays authoritative until a slot is
// edited (preserving imported/loaded fidelity), then that reparse takes over.
const state: EditorState & { roundTexts: string[] } = { game: newGame(), activeKyoku: 0, roundTexts: [''] };
// Per-slot flag: true where the slot has no round token (a WIP placeholder).
let slotPlaceholder: boolean[] = [false];

// The save slot the current game is linked to (set on Save or Load). While set,
// Save overwrites that slot; a full-game import/load clears it so the next Save
// creates a fresh record instead of clobbering the loaded one.
let currentSaveId: string | null = null;

// Cross-round carry-over conflicts from the last rebuild, surfaced as warnings
// on the round they belong to.
let carryConflicts: CarryConflict[] = [];

// A quick-edit (name/haipai/dora/ura) typed before its round token exists has
// nothing to anchor to; it's held here and flushed once the round is entered.
// While pending, the fields hold unsaved input and must not be repopulated.
let pendingQuickEdit = false;

// ---- shell ----
const app = document.getElementById('app')!;
const toolbarEl = el('header', { class: 'toolbar' });
const roundBarEl = el('nav', { class: 'round-bar' });
const panelsEl = el('div', { class: 'panels' });
const replayEl = el('div', { class: 'replay-root' });
app.append(toolbarEl, roundBarEl, panelsEl, replayEl);

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
  renderRoundBar();
}

const replay = mountReplay(replayEl, {
  getEditorLog: () => gameToTenhou(realGame()),
  // Keep the shared round bar's highlight in sync when the replayer changes round.
  onRoundChange: () => { if (mode === 'replay') renderRoundBar(); },
  // A log loaded in the replayer (paste / shared link / load-from-editor) flows
  // back into the editor so switching to Editor shows the same game.
  onLog: (log) => {
    const sig = JSON.stringify(log);
    if (sig === syncedSig) return; // this is the log we just pushed from the editor
    syncedSig = sig;
    try {
      currentSaveId = null;                        // imported log isn't a save yet
      pendingQuickEdit = false; turnState = null;
      const g = tenhouToGame(log);
      // The faithful decode stays authoritative; slots are derived for editing.
      let stream = ''; try { stream = gameToStream(g); } catch { /* keep authoritative */ }
      adoptGame(g, stream);
      state.activeKyoku = Math.max(0, state.game.kyokus.length - 1);
      refreshActiveRoundView();  // textarea shows just the active round
      if (mode === 'editor') renderAll();
    } catch (err) { console.warn('Could not import replay log into editor:', err); }
  },
});
replayEl.style.display = 'none';

/** Push the editor's current game into the replayer, unless it already has it. */
function syncReplayFromEditor() {
  const log = gameToTenhou(realGame());
  const sig = JSON.stringify(log);
  if (sig === syncedSig) return; // replayer already shows this game
  syncedSig = sig;
  replay.loadLog(log);
}

function panel(title: string, key: string, body: HTMLElement, opts: { collapsed?: boolean; grow?: boolean; actions?: (Node | string)[] } = {}): HTMLElement {
  const sec = el('section', { class: `panel${opts.collapsed ? ' collapsed' : ''}${opts.grow ? ' grow' : ''}`, 'data-key': key });
  const toggle = el('button', { class: 'panel-toggle', onClick: () => sec.classList.toggle('collapsed') }, []);
  // Clicks inside .panel-actions don't toggle the panel (they run their own handler).
  const head = el('div', { class: 'panel-head', onClick: (e: Event) => { if ((e.target as HTMLElement).closest('.panel-actions')) return; sec.classList.toggle('collapsed'); } }, [
    toggle, el('span', { class: 'panel-title' }, [title]),
    ...(opts.actions?.length ? [el('div', { class: 'panel-actions' }, opts.actions)] : []),
  ]);
  sec.append(head, el('div', { class: 'panel-body' }, [body]));
  return sec;
}

/** Help dialog: the stream DSL syntax + the quick-entry fields' purpose. */
function openStreamHelp() {
  const row = (term: string, code: string, desc: string) => el('div', { class: 'help-row' }, [
    el('div', { class: 'help-term' }, [term]),
    el('div', { class: 'help-desc' }, [...(code ? [el('code', {}, [code]), ' — '] : []), desc]),
  ]);
  openDialog({
    title: 'Stream transcription',
    body: [
      el('p', { class: 'help-lead' }, ['Transcribe a hand as a stream of space-separated tokens, in order of play:']),
      el('pre', { class: 'help-shape' }, ['<round> [dora] <E haipai> <S> <W> <N>  <discard> ( <draw> <discard> )… <result>']),
      el('div', { class: 'help-grid' }, [
        row('Round', 'e1 … n4', 'Round wind + number. Append honba and riichi sticks: e1.1 or e1.1.2.'),
        row('Dora / Ura', 'd5m · di0p · u3s', 'd = the dora tile (stored as its indicator); di = the indicator directly (needed for a red-5 indicator); u / ui = ura-dora.'),
        row('Haipai', '123m456p77z · Alice:123m…', 'A seat’s 13 starting tiles (the dealer’s 14th is their first draw). Optionally name-prefixed; use ? to skip a seat.'),
        row('Draw', '5m · ?', 'A drawn tile. ? marks an unknown/missed draw.'),
        row('Discard', '3p · x · r3p', 'A discard. x = tsumogiri (throw the tile just drawn); r = the riichi declaration tile.'),
        row('Call', 'pon · chi · kan · chi46m', 'Claim the last discard. Prefix the caller relative to the discarder: k/t/s (kamicha / toimen / shimocha), e.g. kpon. A chi can name its run — chi46m or chi456m — to pick which tiles it uses.'),
        row('Result', 'tsumo · ron · ryuukyoku', 'How the hand ended. Prefix a seat to name the winner on a multi-ron, e.g. eron / sron.'),
      ]),
      el('p', { class: 'help-note muted' }, ['Nothing is thrown away on an error — problems show as diagnostics below the box and parsing continues, so a partial record still renders.']),
      el('h4', { class: 'help-h' }, ['Quick-entry fields']),
      el('p', { class: 'help-lead' }, ['The fields above the textarea edit the active round in place, without disturbing the live play tokens — handy for filling in details during a pause.']),
      el('div', { class: 'help-grid' }, [
        row('Dora / Ura Indicators', '', 'The dead-wall indicator tiles (0p = red 5). Ura is only revealed under a riichi win.'),
        row('Name', '', 'Each seat’s player name, shown E / S / W / N for the active round. New Round carries these forward.'),
        row('Score', '', 'Each seat’s starting points (default 25000). For later rounds this is normally carried from the previous round automatically.'),
        row('Haipai', '', 'Each seat’s 13 starting tiles. Leave blank if you didn’t record them — the engine backfills what it can from later play.'),
      ]),
    ],
  });
}

// stream panel
const streamInput = el('textarea', { class: 'field-control mono stream-input', spellcheck: 'false', placeholder: 'e1 d5m  Alice:123456789m1234z1z  Bob:…  Carol:…  Dave:…  1z  9p 8p  …' }) as HTMLTextAreaElement;
const diagEl = el('div', { class: 'diagnostics' });

// Quick-edit row: fill in the current hand's dora indicator and each haipai
// later (e.g. during a pause), splicing into the raw stream without touching the
// live play tokens. Fields reflect the active kyoku and edit it in place.
const WINDS = ['E', 'S', 'W', 'N'];
const isDefaultName = (n: string) => !n || /^Player \d$/.test(n);
const doraField = el('input', { class: 'field-control mono q-in', spellcheck: 'false', placeholder: 'dora 6p', title: 'Dora indicator — the dead-wall tile (0p = red 5p)' }) as HTMLInputElement;
const uraField = el('input', { class: 'field-control mono q-in', spellcheck: 'false', placeholder: 'ura 3s', title: 'Ura-dora indicator(s), revealed under a riichi win' }) as HTMLInputElement;
const nameFields: HTMLInputElement[] = [];
const scoreFields: HTMLInputElement[] = [];
const haipaiFields: HTMLInputElement[] = [];
const seatLabels: HTMLElement[] = [];
// First column holds the dora indicator (aligned with the name row) and the ura
// indicator below it (aligned with the haipai row); each seat column is wind /
// name+score / haipai, so the fields line up across.
const quickRow = el('div', { class: 'stream-quick' }, [
  el('div', { class: 'q-field' }, [el('span', { class: 'q-lbl' }, ['Dora / Ura Indicators']), doraField, uraField]),
]);
for (let s = 0; s < 4; s++) {
  const lbl = el('span', { class: 'q-lbl' }, [WINDS[s]]);
  const nameInp = el('input', { class: 'field-control q-in q-name', spellcheck: 'false', placeholder: 'name' }) as HTMLInputElement;
  const scoreInp = el('input', { class: 'field-control mono q-in q-score', type: 'number', min: '0', step: '100', placeholder: '25000', title: 'Starting points' }) as HTMLInputElement;
  const inp = el('input', { class: 'field-control mono q-in q-hp', spellcheck: 'false', placeholder: 'haipai' }) as HTMLInputElement;
  seatLabels.push(lbl); nameFields.push(nameInp); scoreFields.push(scoreInp); haipaiFields.push(inp);
  quickRow.append(el('div', { class: 'q-field' }, [lbl, el('div', { class: 'q-namerow' }, [nameInp, scoreInp]), inp]));
}
const streamBody = el('div', { class: 'stream-panel' }, [quickRow, streamInput, diagEl]);

// Live turn indicator: mark the seat that has to act next in an open hand.
let turnState: { seat: number; expect: 'draw' | 'discard' } | null = null;
function renderTurnIndicator() {
  seatLabels.forEach((lbl, s) => {
    const on = turnState?.seat === s;
    lbl.textContent = (on ? '▸ ' : '') + WINDS[s];
    lbl.classList.toggle('turn', on);
    lbl.title = on ? (turnState!.expect === 'draw' ? 'to draw' : 'to discard') : '';
  });
}

/** Mirror the active kyoku's dora, names and haipai into the quick-edit fields. */
function populateQuickFields() {
  if (pendingQuickEdit) return; // fields hold unsaved input — don't clobber it
  const k = state.game.kyokus[state.activeKyoku];
  if (!k) { doraField.value = ''; uraField.value = ''; nameFields.forEach((f) => (f.value = '')); scoreFields.forEach((f) => (f.value = '')); haipaiFields.forEach((f) => (f.value = '')); return; }
  doraField.value = tilesToNotation(k.doraIndicators);
  uraField.value = tilesToNotation(k.uraIndicators);
  // Haipai fields mirror what was *recorded* (from the raw stream), not the tiles
  // the parser backfilled from later play — so they don't fill themselves in.
  const recorded = readHaipai(activeSlotText(), 0);
  for (let s = 0; s < 4; s++) {
    const p = k.players[(k.round + s) % 4];
    haipaiFields[s].value = recorded[s];
    nameFields[s].value = isDefaultName(p.name) ? '' : p.name;
    scoreFields[s].value = String(p.startScore);
  }
}

const quickFieldValues = () => ({ dora: doraField.value, ura: uraField.value, haipai: haipaiFields.map((f) => f.value), names: nameFields.map((f) => f.value), scores: scoreFields.map((f) => f.value) });
const isRoundTok = (t: string) => /^[eswn][1-4]([._\-][0-9]+){0,2}$/i.test(t);
const hasRoundFor = (text: string, idx: number) => text.split(/[\s,]+/).filter(isRoundTok).length > idx;

// ---- per-round slots ⇄ game model ----

/** The canonical whole-game DSL: the non-empty round slots joined. */
function fullStream(): string { return state.roundTexts.map((t) => t.trim()).filter(Boolean).join('\n'); }

/** The game with placeholder (tokenless, WIP) rounds dropped — for output. */
function realGame(): Game { return { ...state.game, kyokus: state.game.kyokus.filter((_, i) => !slotPlaceholder[i]) }; }

/** The active slot's text (what the textarea shows/edits). */
const activeSlotText = () => state.roundTexts[state.activeKyoku] ?? '';

/** Split a whole-game stream into one text slot per round. */
function setRoundTextsFromStream(stream: string) {
  const regions = roundRegions(stream);
  state.roundTexts = regions.length
    ? regions.map((r) => stream.slice(r.start, r.end).trim())
    : (stream.trim() ? [stream.trim()] : ['']);
  slotPlaceholder = state.roundTexts.map(() => false);
}

/** Carry-over + game-level names + activeKyoku clamp, after the model changes. */
function finalizeModel() {
  carryConflicts = state.game.kyokus.length ? applyCarryOver(state.game) : [];
  const firstReal = slotPlaceholder.findIndex((p) => !p);
  if (firstReal >= 0) state.game.meta.names = state.game.kyokus[firstReal].players.map((p) => p.name) as Game['meta']['names'];
  if (state.activeKyoku >= state.game.kyokus.length) state.activeKyoku = Math.max(0, state.game.kyokus.length - 1);
}

/** Rebuild every kyoku from its slot's text, keeping the model 1:1 with the
 *  slots (a tokenless slot becomes a placeholder so its tab persists). */
function rebuildFromSlots() {
  const kyokus: Kyoku[] = [];
  slotPlaceholder = [];
  state.roundTexts.forEach((text, i) => {
    const r = parseStream(text);
    if (r.game.kyokus.length) { kyokus.push(r.game.kyokus[0]); slotPlaceholder.push(false); }
    else { kyokus.push(emptyKyoku(i)); slotPlaceholder.push(true); } // WIP slot keeps its tab
  });
  // Keep the UI-only meta the DSL doesn't encode (title, aka rule flag).
  state.game = { meta: { ...state.game.meta }, kyokus };
  finalizeModel();
}

/** Adopt an authoritative game (import / load) as the model, deriving one text
 *  slot per round without reparsing — so a faithful decode isn't lost. */
function adoptGame(game: Game, stream: string) {
  state.game = game;
  setRoundTextsFromStream(stream);
  if (state.game.kyokus.length !== state.roundTexts.length) { rebuildFromSlots(); return; }
  finalizeModel();
}

/** Carry-over conflicts for the active round, as textarea-anchored warnings. */
function conflictDiags(): Diagnostic[] {
  const end = Math.max(0, streamInput.value.search(/\s|$/));
  return carryConflicts
    .filter((c) => c.kyoku === state.activeKyoku)
    .map((c) => ({ severity: 'warn' as const, message: c.message, start: 0, end }));
}

/** Diagnostics + turn indicator for the visible round, offsets matching the
 *  textarea. Call after the active slot's text or the model changes. */
function renderActiveDiagnostics() {
  const r = parseStream(activeSlotText());
  turnState = r.pending ?? null;
  renderDiagnostics([...r.diagnostics, ...conflictDiags()], r.missing);
  renderTurnIndicator();
}

/** Point the textarea at the active round and refresh its diagnostics/turn (used
 *  when the active round changes without the user typing). */
function refreshActiveRoundView() {
  streamInput.value = activeSlotText();
  renderActiveDiagnostics();
}

/** A user edit to the active round's textarea: store it, rebuild, re-render. */
function onActiveRoundEdited() {
  rebuildFromSlots();
  // Flush a quick-edit that couldn't anchor until the round token was typed.
  if (pendingQuickEdit && hasRoundFor(activeSlotText(), 0)) {
    const spliced = spliceRoundHeader(activeSlotText(), 0, quickFieldValues());
    if (spliced !== activeSlotText()) { state.roundTexts[state.activeKyoku] = spliced; streamInput.value = spliced; rebuildFromSlots(); }
    pendingQuickEdit = false;
  }
  renderRoundBar(); renderForm(); renderBoardPanel(); renderJson();
  renderActiveDiagnostics();
  populateQuickFields();
}

/** A quick-field edit: splice the new dora / ura / names / haipai into the active
 *  round (each slot is a single round, so it anchors at index 0). */
function onQuickEdit() {
  const edit = quickFieldValues();
  if (!hasRoundFor(activeSlotText(), 0)) {
    pendingQuickEdit = !!(edit.dora || edit.ura || edit.haipai.some(Boolean) || edit.names.some(Boolean) || edit.scores.some((s) => s && s !== '25000'));
    return; // no round token yet — keep the field values and wait for it
  }
  pendingQuickEdit = false;
  state.roundTexts[state.activeKyoku] = spliceRoundHeader(activeSlotText(), 0, edit);
  streamInput.value = activeSlotText();
  rebuildFromSlots();
  renderForm(); renderBoardPanel(); renderJson();
  renderActiveDiagnostics();
}
[doraField, uraField, ...nameFields, ...scoreFields, ...haipaiFields].forEach((f) => f.addEventListener('input', onQuickEdit));

// board / form / json bodies
const boardBody = el('div', { class: 'board-wrap' });
const metaEl = el('section', { class: 'meta' });
const editorEl = el('main', { class: 'editor' });
const formBody = el('div', { class: 'form-wrap' }, [metaEl, editorEl]);
const jsonBody = el('div', { class: 'json-pane' });

// Game title lives at the top of the editor (it's the name a save is stored under).
const titleInput = el('input', {
  class: 'field-control game-title-in', spellcheck: 'false', placeholder: 'Untitled game', 'aria-label': 'Game title',
  onInput: (e: Event) => { state.game.meta.title[0] = (e.target as HTMLInputElement).value; renderBoardPanel(); renderJson(); },
}) as HTMLInputElement;
const titleBar = el('div', { class: 'game-title-bar' }, [titleInput]);
const syncTitleInput = () => { titleInput.value = state.game.meta.title[0] ?? ''; };

const streamHelpBtn = el('button', { class: 'btn small icon', title: 'Transcription syntax help', onClick: (e: Event) => { e.stopPropagation(); openStreamHelp(); } }, [icon('help')]);
panelsEl.append(
  titleBar,
  panel('Stream transcription', 'stream', streamBody, { grow: true, actions: [streamHelpBtn] }),
  panel('Board', 'board', boardBody),
  panel('Form editor', 'form', formBody, { collapsed: true }),
  panel('tenhou/6 JSON', 'json', jsonBody, { collapsed: true }),
);

streamInput.addEventListener('input', () => {
  while (state.roundTexts.length <= state.activeKyoku) state.roundTexts.push('');
  state.roundTexts[state.activeKyoku] = streamInput.value; // edits the active slot only
  onActiveRoundEdited();
});

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
    el('button', { class: 'btn has-icon', onClick: newRecord, title: 'Start a new blank record' }, [icon('note_add'), 'New']),
    el('button', { class: 'btn has-icon', onClick: quickSave, title: 'Save this game in your browser' }, [icon('save'), 'Save']),
    el('button', { class: 'btn has-icon', onClick: openSavesDialog, title: 'Open a saved game' }, [icon('folder_open'), 'Open']),
    el('button', { class: 'btn has-icon', onClick: openImportDialog }, [icon('upload_file'), 'Import']),
    el('button', { class: 'btn has-icon primary', onClick: openExportDialog }, [icon('download'), 'Export']),
  );
}

function renderMeta() {
  clear(metaEl);
  const g = state.game.meta;
  const names = el('div', { class: 'names' });
  for (let i = 0; i < 4; i++) names.append(el('label', { class: 'field' }, [`P${i}`, el('input', { class: 'field-control', value: g.names[i], onInput: (e: Event) => { g.names[i] = (e.target as HTMLInputElement).value; renderJson(); } })]));
  metaEl.append(names);
  const aka = el('input', { type: 'checkbox', onChange: (e: Event) => { g.rule.aka = (e.target as HTMLInputElement).checked ? 1 : 0; renderJson(); } }) as HTMLInputElement;
  aka.checked = !!g.rule.aka;
  metaEl.append(el('label', { class: 'field inline' }, [aka, 'Red fives (aka)']));
}

// ---- shared round bar (both editor and replay) ----
/** The round the bar highlights: the editor's active kyoku, or the replayer's. */
const activeRound = () => (mode === 'replay' ? replay.currentKyoku() : state.activeKyoku);

function selectRound(i: number) {
  if (mode === 'replay') { replay.showKyoku(i); renderRoundBar(); }
  else { state.activeKyoku = i; refreshActiveRoundView(); renderAll(); }
}

/** New Round: append a fresh round slot (its token defaulted to the next round)
 *  and open it for transcribing. No paste screen — use Import for logs. */
function newRound() {
  const real = realGame().kyokus;                       // ignore any WIP placeholder slots
  const next = real.length ? Math.min(15, real[real.length - 1].round + 1) : 0;
  const tok = `${['e', 's', 'w', 'n'][Math.floor(next / 4)]}${(next % 4) + 1}`;
  // Carry the players' names from the previous round, in the new round's seat
  // order (E,S,W,N → fixed (next+s)%4), so the transcriber doesn't re-key them.
  const prev = real[real.length - 1];
  const names = [0, 1, 2, 3].map((s) => {
    const n = prev?.players[(next + s) % 4]?.name ?? '';
    return isDefaultName(n) ? '' : n;
  });
  const slot = names.some(Boolean)
    ? spliceRoundHeader(tok, 0, { dora: '', ura: '', haipai: ['', '', '', ''], names, scores: ['', '', '', ''] })
    : tok;
  state.roundTexts.push(slot);
  rebuildFromSlots();
  state.activeKyoku = state.roundTexts.length - 1;       // focus the new round
  refreshActiveRoundView();                              // textarea shows just the new round
  if (mode !== 'editor') setMode('editor'); else renderAll();
}

function deleteRound(i: number, label: string) {
  if (state.roundTexts.length <= 1) return;
  if (!confirm(`Delete ${label}? This edits the game across all views.`)) return;
  state.roundTexts.splice(i, 1);
  if (state.activeKyoku > i) state.activeKyoku -= 1;
  state.activeKyoku = Math.max(0, Math.min(state.activeKyoku, state.roundTexts.length - 1));
  rebuildFromSlots();
  refreshActiveRoundView();
  if (mode === 'replay') syncReplayFromEditor();
  renderAll();
}

function renderRoundBar() {
  clear(roundBarEl);
  const kyokus = state.game.kyokus;
  const active = activeRound();
  const canDelete = kyokus.length > 1;
  kyokus.forEach((k, i) => {
    const label = `${roundName(k.round)}${k.honba ? `-${k.honba}` : ''}`;
    roundBarEl.append(el('div', { class: `tab kyoku${i === active ? ' active' : ''}` }, [
      el('button', { class: 'tab-label', onClick: () => selectRound(i) }, [label]),
      ...(canDelete ? [el('button', { class: 'tab-del', title: `Delete ${label}`, onClick: (e: Event) => { e.stopPropagation(); deleteRound(i, label); } }, [icon('close')])] : []),
    ]));
  });
  roundBarEl.append(el('button', { class: 'tab add', title: 'Add a new blank round', onClick: newRound }, [icon('add'), 'New Round']));
}

// Export scope: the whole game, or just the active round.
type Scope = 'round' | 'game';
function gameForScope(scope: Scope): Game {
  if (scope === 'game') return realGame();
  const k = state.game.kyokus[state.activeKyoku];
  return { ...state.game, kyokus: k && !slotPlaceholder[state.activeKyoku] ? [k] : [] };
}
const roundLabel = (k?: { round: number; honba: number }) => (k ? `${roundName(k.round)}${k.honba ? `-${k.honba}` : ''}` : 'round');

// tenhou-JSON surfaces (panel, download, copy, viewer) strip arbitrary aka,
// which tenhou can't represent. Native surfaces (share, PDF embed, replay
// sync via getEditorLog) keep the faithful gameToTenhou(state.game).
const buildLog = (scope: Scope = 'game') => gameToTenhou(tenhouCompatible(gameForScope(scope)));
function renderJson() {
  clear(jsonBody);
  const head = el('div', { class: 'json-head' }, [
    el('span', {}, [`${realGame().kyokus.length} kyoku`]),
    el('button', { class: 'btn small has-icon', onClick: () => copyJson('game') }, [icon('content_copy'), 'Copy']),
  ]);
  jsonBody.append(head, el('pre', { class: 'json' }, [JSON.stringify(buildLog('game'), null, 1)]));
}
function renderBoardPanel() { renderBoard(boardBody, state.game.kyokus[state.activeKyoku], state.game.meta.title[0]); }
function renderForm() { renderMeta(); const k = state.game.kyokus[state.activeKyoku]; if (k) renderKyoku(editorEl, k, { rerender: renderAll, refreshJson: renderJson }); else clear(editorEl); }

/** Full refresh of the derived views (not the stream textarea). */
function renderAll() { renderToolbar(); renderRoundBar(); syncTitleInput(); renderForm(); renderBoardPanel(); renderJson(); populateQuickFields(); renderTurnIndicator(); }

function renderDiagnostics(diags: Diagnostic[], missing: number) {
  clear(diagEl);
  if (!diags.length) { diagEl.append(el('span', { class: 'diag-ok' }, [streamInput.value.trim() ? '✓ no issues' : ''])); return; }
  const errs = diags.filter((d) => d.severity === 'error').length;
  const warns = diags.filter((d) => d.severity === 'warn').length;
  diagEl.append(el('div', { class: 'diag-summary' }, [`${errs} error${errs === 1 ? '' : 's'}, ${warns} warning${warns === 1 ? '' : 's'}${missing ? `, ${missing} missed (?)` : ''}`]));
  const list = el('div', { class: 'diag-list' });
  for (const d of diags.slice(0, 40)) {
    // Offsets are relative to the single-round textarea, not the full stream.
    const snippet = streamInput.value.slice(d.start, d.end);
    list.append(el('div', { class: `diag ${d.severity}`, onClick: () => { streamInput.focus(); streamInput.setSelectionRange(d.start, d.end); } }, [el('code', {}, [snippet || '·']), ' ', d.message]));
  }
  diagEl.append(list);
}

// ---- import / export ----

/** Adopt an imported game: update the model, refresh the editable stream, render. */
function loadGame(game: Game) {
  currentSaveId = null;   // a freshly imported game isn't linked to a save yet
  pendingQuickEdit = false; turnState = null;
  let stream = ''; try { stream = gameToStream(game); } catch { /* keep authoritative */ }
  adoptGame(game, stream);   // model stays authoritative; slots derived from the stream
  state.activeKyoku = 0;
  refreshActiveRoundView();
  renderAll();
}

/** Start over with a blank record — the same clean slate as a fresh page load. */
function newRecord() {
  if (fullStream().trim() && !confirm('Start a new record? Unsaved changes to the current one will be lost.')) return;
  state.game = newGame();
  state.roundTexts = [''];        // one empty East 1 slot
  slotPlaceholder = [false];
  state.activeKyoku = 0;
  currentSaveId = null;           // not linked to any saved game
  pendingQuickEdit = false; turnState = null; carryConflicts = [];
  if (mode !== 'editor') setMode('editor');
  refreshActiveRoundView();
  renderAll();
  flash('Started a new record');
}

// ---- local save / load (localStorage) ----

/** Save the working game to the browser. A first save asks for a name (which
 *  becomes the game's title); re-saving overwrites the linked slot silently. */
function quickSave() {
  try {
    if (!currentSaveId) {
      const suggested = (state.game.meta.title[0] || '').trim() || 'Untitled game';
      const name = prompt('Name this save:', suggested);
      if (name === null) return; // cancelled
      state.game.meta.title[0] = name.trim();
      syncTitleInput(); renderBoardPanel(); renderJson(); // the save name is the game title
    }
    const rec = makeSave(realGame(), fullStream(), { id: currentSaveId ?? undefined });
    writeSave(rec);
    currentSaveId = rec.id;
    flash(`Saved “${rec.title}”`);
  } catch (err) { alert('Save failed: ' + (err as Error).message); }
}

/** Restore a saved record: the model is authoritative, the stream reproduces the
 *  textarea verbatim (setting .value fires no 'input', so the model stays intact). */
function loadSave(id: string) {
  const rec = readSave(id);
  if (!rec) { alert('That save could not be read.'); return; }
  currentSaveId = rec.id;
  pendingQuickEdit = false; turnState = null;
  adoptGame(rec.game, rec.stream);  // model authoritative; slots from the saved stream
  state.activeKyoku = 0;
  refreshActiveRoundView();
  if (mode === 'replay') syncReplayFromEditor();
  renderAll();
  flash(`Opened “${rec.title}”`);
}

const fmtWhen = (ms: number) => { try { return new Date(ms).toLocaleString(); } catch { return ''; } };

function openSavesDialog() {
  const listEl = el('div', { class: 'saves-list' });
  const dlg = openDialog({
    title: 'Open a saved game',
    body: [
      el('div', { class: 'muted saves-note' }, ['Saved in this browser. Use Export to download a copy you can keep or move.']),
      listEl,
    ],
  });

  function renderList() {
    clear(listEl);
    const saves = listSaves();
    if (!saves.length) { listEl.append(el('div', { class: 'saves-empty muted' }, ['No saved games yet. Use ', el('b', {}, ['Save']), ' to store this one.'])); return; }
    for (const s of saves) listEl.append(saveRow(s));
  }

  function saveRow(s: SaveMeta): HTMLElement {
    const meta = `${s.rounds} round${s.rounds === 1 ? '' : 's'} · ${fmtWhen(s.savedAt)}${s.id === currentSaveId ? ' · current' : ''}`;
    return el('div', { class: `saves-row${s.id === currentSaveId ? ' current' : ''}` }, [
      el('div', { class: 'saves-info' }, [
        el('div', { class: 'saves-title' }, [s.title || 'Untitled game']),
        el('div', { class: 'saves-meta muted' }, [meta]),
      ]),
      el('div', { class: 'saves-actions' }, [
        el('button', { class: 'btn small has-icon primary', onClick: () => { loadSave(s.id); dlg.close(); } }, [icon('folder_open'), 'Open']),
        el('button', { class: 'btn small icon', title: 'Rename this save', onClick: () => renameSave(s) }, [icon('edit')]),
        el('button', { class: 'btn small icon', title: 'Duplicate this save', onClick: () => duplicateSave(s) }, [icon('content_copy')]),
        el('button', { class: 'btn small icon danger', title: 'Delete this save', onClick: () => {
          if (!confirm(`Delete save “${s.title}”? This can’t be undone.`)) return;
          deleteSave(s.id);
          if (s.id === currentSaveId) currentSaveId = null;
          renderList();
        } }, [icon('delete')]),
      ]),
    ]);
  }

  /** Rename a save; if it's the current game, keep the working title in sync. */
  function renameSave(s: SaveMeta) {
    const name = prompt('Rename save:', s.title);
    if (name === null) return;
    const rec = readSave(s.id);
    if (!rec) { alert('That save could not be read.'); return; }
    rec.title = name.trim() || 'Untitled game';
    writeSave(rec);
    if (s.id === currentSaveId) { state.game.meta.title[0] = rec.title; syncTitleInput(); renderBoardPanel(); renderJson(); }
    renderList();
  }

  /** Write an independent copy of a save under a new name (new id). */
  function duplicateSave(s: SaveMeta) {
    const rec = readSave(s.id);
    if (!rec) { alert('That save could not be read.'); return; }
    writeSave(makeSave(rec.game, rec.stream, { title: `${rec.title} (copy)` }));
    renderList();
    flash(`Copied “${rec.title}”`);
  }

  renderList();
}

const isPdfBytes = (buf: ArrayBuffer) => new TextDecoder().decode(new Uint8Array(buf, 0, 5)) === '%PDF-';
const baseName = () => (state.game.meta.title[0] || 'paifu').replace(/\s+/g, '_');

/** Merge one round of an imported game into the current game at `targetRound`,
 *  replacing an existing round with that number or inserting it in round order. */
function importRound(game: Game, targetRound: number) {
  const k = game.kyokus[0];
  if (!k) { alert('No round found in that log.'); return; }
  k.round = targetRound;
  const kyokus = [...realGame().kyokus];   // drop any WIP placeholder slots
  const at = kyokus.findIndex((x) => x.round === targetRound);
  if (at >= 0) kyokus[at] = k; else kyokus.push(k);
  kyokus.sort((a, b) => a.round - b.round || a.honba - b.honba);
  const merged: Game = { ...state.game, kyokus };
  pendingQuickEdit = false; turnState = null;
  let stream = ''; try { stream = gameToStream(merged); } catch { /* keep authoritative */ }
  adoptGame(merged, stream);
  state.activeKyoku = Math.max(0, kyokus.indexOf(k));
  refreshActiveRoundView();
  renderAll();
}

function openImportDialog() {
  // Scope: replace the whole game, or slot one round into the current game.
  let scope: Scope = 'game';
  const nextRound = state.game.kyokus.length ? Math.min(15, state.game.kyokus[state.game.kyokus.length - 1].round + 1) : 0;
  // If the active round is completely empty (nothing beyond maybe its own token),
  // default to importing INTO it rather than appending after it.
  const activeToks = activeSlotText().split(/[\s,]+/).filter(Boolean);
  const activeEmpty = activeToks.length === 0 || (activeToks.length === 1 && isRoundTok(activeToks[0]));
  const defaultRound = activeEmpty ? (state.game.kyokus[state.activeKyoku]?.round ?? nextRound) : nextRound;
  const roundSel = el('select', { class: 'field-control round-sel' }, Array.from({ length: 16 }, (_, r) => el('option', { value: String(r) }, [roundName(r)]))) as HTMLSelectElement;
  roundSel.value = String(defaultRound);
  const segGame = el('button', { class: 'btn seg', onClick: () => setScope('game') }, ['Full game']);
  const segRound = el('button', { class: 'btn seg', onClick: () => setScope('round') }, ['Single round']);
  const roundWrap = el('label', { class: 'round-sel-wrap muted' }, ['into ', roundSel]);
  const setScope = (s: Scope) => { scope = s; segGame.classList.toggle('primary', s === 'game'); segRound.classList.toggle('primary', s === 'round'); roundWrap.style.display = s === 'round' ? 'inline-flex' : 'none'; };
  setScope('game');

  const apply = (game: Game, what: string) => {
    if (scope === 'round') importRound(game, Number(roundSel.value));
    else loadGame(game);
    flash(scope === 'round' ? `Imported ${what} → ${roundName(Number(roundSel.value))}` : `Imported ${what}`);
    dlg.close();
  };

  const fileInput = el('input', { type: 'file', accept: '.pdf,.json,application/json,application/pdf', class: 'hidden', onChange: (e: Event) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) void handleFile(f); } }) as HTMLInputElement;
  const drop = el('div', { class: 'dropzone', onClick: () => fileInput.click() }, [
    icon('upload_file'), el('div', { class: 'dz-main' }, ['Drag & drop a Paifun PDF or Tenhou JSON']), el('div', { class: 'muted' }, ['or click to browse']),
  ]);
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); const f = (e as DragEvent).dataTransfer?.files?.[0]; if (f) void handleFile(f); });

  const paste = el('textarea', { class: 'field-control mono paste-json', spellcheck: 'false', placeholder: '…or paste Tenhou/6 JSON here' }) as HTMLTextAreaElement;
  const dlg = openDialog({
    title: 'Import',
    body: [
      el('div', { class: 'export-scope' }, [el('span', { class: 'muted' }, ['Import as:']), segGame, segRound, roundWrap]),
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
        if (embedded) { apply(tenhouToGame(embedded), 'PaifuPlus PDF'); return; }
        const { kyokus, errors } = await importPdf(buf);
        if (!kyokus.length) { alert('No hands found in that PDF.'); return; }
        apply(gameFromKyokus(kyokus, f.name.replace(/\.pdf$/i, '')), 'Paifun PDF');
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
    apply(tenhouToGame(log), 'Tenhou JSON');
  }
}

function openExportDialog() {
  const warning = hasNonTenhouTiles(realGame())
    ? [el('div', { class: 'dialog-warning' }, [icon('warning'), el('span', {}, ['This record has aka dora on non-five tiles, which tenhou’s format can’t represent. They export as plain tiles in the Tenhou JSON and viewer — the PDF and PaifuPlus share links keep them.'])])]
    : [];
  // Scope selector: export just the active round or the whole game.
  const roundCount = realGame().kyokus.length;
  let scope: Scope = roundCount > 1 ? 'game' : 'round';
  const segRound = el('button', { class: 'btn seg', onClick: () => setScope('round') }, [`This round (${roundLabel(state.game.kyokus[state.activeKyoku])})`]);
  const segGame = el('button', { class: 'btn seg', onClick: () => setScope('game') }, [`Full game (${roundCount} rounds)`]);
  const setScope = (s: Scope) => { scope = s; segRound.classList.toggle('primary', s === 'round'); segGame.classList.toggle('primary', s === 'game'); };
  setScope(scope);
  openDialog({
    title: 'Export',
    body: [
      ...warning,
      el('div', { class: 'export-scope' }, [el('span', { class: 'muted' }, ['Export:']), segRound, segGame]),
      el('div', { class: 'export-row' }, [
        el('button', { class: 'btn has-icon primary', onClick: () => exportPdf('en', scope) }, [icon('download'), 'Paifu PDF (English)']),
        el('button', { class: 'btn has-icon primary', onClick: () => exportPdf('ja', scope) }, [icon('download'), 'Paifu PDF (日本語)']),
      ]),
      el('div', { class: 'export-row' }, [el('span', { class: 'muted' }, ['PAIFUN-style paifu, rendered by PaifuPlus — re-importable'])]),
      el('div', { class: 'export-row' }, [
        el('button', { class: 'btn has-icon', onClick: () => { downloadJson(scope); flash('Downloaded JSON'); } }, [icon('download'), 'Download Tenhou JSON']),
        el('button', { class: 'btn has-icon', onClick: () => copyJson(scope) }, [icon('content_copy'), 'Copy JSON']),
      ]),
      el('div', { class: 'export-row' }, [
        el('button', { class: 'btn has-icon', onClick: () => openInTenhou(scope) }, [icon('open_in_new'), 'Open in Tenhou viewer']),
      ]),
    ],
  });
}

/** Open the current log in tenhou's online viewer (data rides in the URL fragment). */
function openInTenhou(scope: Scope = 'game') {
  const url = 'https://tenhou.net/5/#json=' + encodeURIComponent(jsonText(scope));
  window.open(url, '_blank', 'noopener');
}

async function exportPdf(lang: 'en' | 'ja', scope: Scope = 'game') {
  try {
    const bytes = await gameToPaifuPdf(gameForScope(scope), lang);
    const suffix = scope === 'round' ? `_${roundLabel(state.game.kyokus[state.activeKyoku])}` : '';
    downloadBlob(new Blob([bytes as BlobPart], { type: 'application/pdf' }), `${baseName()}${suffix}_${lang}.pdf`);
    flash('Downloaded PDF');
  } catch (err) { alert('PDF export failed: ' + (err as Error).message); }
}

const jsonText = (scope: Scope = 'game') => JSON.stringify(buildLog(scope));
async function copyJson(scope: Scope = 'game') { try { await navigator.clipboard.writeText(jsonText(scope)); flash('Copied JSON'); } catch { alert('Copy failed — use Download.'); } }
function downloadJson(scope: Scope = 'game') {
  const suffix = scope === 'round' ? `_${roundLabel(state.game.kyokus[state.activeKyoku])}` : '';
  downloadBlob(new Blob([jsonText(scope)], { type: 'application/json' }), `${baseName()}${suffix}.json`);
}
function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}
function flash(msg: string) { const f = el('div', { class: 'flash' }, [msg]); document.body.append(f); setTimeout(() => f.remove(), 1600); }

refreshActiveRoundView();  // textarea + diagnostics for the initial (empty) round
renderAll();

// A shared link (#replay=...) opens straight into the replayer.
const shared = readShareFromUrl();
if (shared) { setMode('replay'); replay.loadShared(shared); }
