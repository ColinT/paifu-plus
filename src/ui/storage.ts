/**
 * Local save/load for game records.
 *
 * Records use our own versioned format — NOT tenhou/6 JSON, which can't
 * represent arbitrary aka (red) tiles. Each save carries both the faithful
 * `game` model (lossless, the authoritative snapshot) and the editable `stream`
 * DSL text, so loading restores the editor exactly as it was saved.
 *
 * Storage is localStorage today; the same record shape is what a cloud backend
 * would store later. The `version` field lets newer builds migrate older saves.
 */

import type { Game } from '../core/model.js';

export const SAVE_FORMAT = 'paifu-plus';
export const SAVE_VERSION = 1;
const PREFIX = 'paifuplus:save:';

export interface PaifuSave {
  format: typeof SAVE_FORMAT;
  version: number;
  id: string;
  title: string;
  /** Epoch ms of the last write. */
  savedAt: number;
  rounds: number;
  /** The editable stream-transcription DSL (supports arbitrary aka tiles). */
  stream: string;
  /** The parsed model snapshot — lossless, the authoritative copy on load. */
  game: Game;
}

/** The light metadata used to render the saves list, without the heavy game. */
export type SaveMeta = Pick<PaifuSave, 'id' | 'title' | 'savedAt' | 'rounds' | 'version'>;

/** The subset of the Web Storage API we use; injectable so tests need no DOM. */
export interface StoreLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
  key(i: number): string | null;
  readonly length: number;
}

/** An in-memory StoreLike, for tests and as a fallback when localStorage is off. */
export function memoryStore(): StoreLike {
  const m = new Map<string, string>();
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => { m.set(k, v); },
    removeItem: (k) => { m.delete(k); },
    key: (i) => Array.from(m.keys())[i] ?? null,
    get length() { return m.size; },
  };
}

let fallback: StoreLike | null = null;
/** localStorage when available (and not blocked), else a shared memory store. */
function defaultStore(): StoreLike {
  try {
    if (typeof localStorage !== 'undefined') { localStorage.getItem(PREFIX + '__probe'); return localStorage as unknown as StoreLike; }
  } catch { /* disabled (private mode / quota) — fall through */ }
  return (fallback ??= memoryStore());
}

function safeParse(raw: string | null): unknown {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** Validate and forward-migrate a stored record; null if it isn't one of ours. */
function migrate(raw: unknown): PaifuSave | null {
  const r = raw as Partial<PaifuSave> | null;
  if (!r || r.format !== SAVE_FORMAT || !r.game || !Array.isArray(r.game.kyokus)) return null;
  let rec = r as PaifuSave;
  // Upgrade older versions here as the format evolves, e.g.:
  //   if (rec.version < 2) rec = { ...rec, version: 2, /* new fields */ };
  if (rec.version < SAVE_VERSION) rec = { ...rec, version: SAVE_VERSION };
  return rec;
}

let idCounter = 0;
/** A reasonably unique id (time + counter + randomness) for a new save. */
export function newSaveId(): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 6);
  return `s${t}${(idCounter++).toString(36)}${r}`;
}

/** Assemble a record from the working game + stream; caller supplies id to update. */
export function makeSave(
  game: Game,
  stream: string,
  opts: { id?: string; savedAt?: number; title?: string } = {},
): PaifuSave {
  const title = (opts.title ?? game.meta.title[0] ?? '').trim() || 'Untitled game';
  return {
    format: SAVE_FORMAT, version: SAVE_VERSION,
    id: opts.id ?? newSaveId(), title,
    savedAt: opts.savedAt ?? Date.now(),
    rounds: game.kyokus.length, stream, game,
  };
}

export function writeSave(rec: PaifuSave, st: StoreLike = defaultStore()): void {
  st.setItem(PREFIX + rec.id, JSON.stringify(rec));
}

export function readSave(id: string, st: StoreLike = defaultStore()): PaifuSave | null {
  return migrate(safeParse(st.getItem(PREFIX + id)));
}

export function deleteSave(id: string, st: StoreLike = defaultStore()): void {
  st.removeItem(PREFIX + id);
}

/** All saved records' metadata, newest first. */
export function listSaves(st: StoreLike = defaultStore()): SaveMeta[] {
  const out: SaveMeta[] = [];
  for (let i = 0; i < st.length; i++) {
    const k = st.key(i);
    if (!k || !k.startsWith(PREFIX)) continue;
    const rec = migrate(safeParse(st.getItem(k)));
    if (rec) out.push({ id: rec.id, title: rec.title, savedAt: rec.savedAt, rounds: rec.rounds, version: rec.version });
  }
  return out.sort((a, b) => b.savedAt - a.savedAt);
}
