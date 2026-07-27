/**
 * The PDF layer — the single interface for everything PDF.
 *
 * The rest of the app does all PDF work through this module and never imports a
 * PDF library directly. Reading (importing a paifu, recovering an embedded log)
 * is backed by pdfjs and writing (the paifu export) by pdf-lib, but that split —
 * and the two libraries — stay hidden behind here. To fix a consumption point or
 * swap a library, touch only the adapter (./reader.ts for reading, ./writer.ts
 * for writing); callers of this facade don't change.
 */

import { importPdf, readEmbeddedLog as readEmbedded } from './reader.js';
import type { ImportResult } from './reader.js';
import { gameToPaifuPdf } from './writer.js';
import type { PaifuLang } from './writer.js';
import type { Game } from '../core/model.js';

export type { ImportResult, PaifuLang };

/** Parse a PAIFUN-format PDF's pages into kyokus, with any per-page errors. */
export function importPaifuPdf(data: ArrayBuffer): Promise<ImportResult> {
  return importPdf(data);
}

/** Recover the tenhou/6 log embedded in a PaifuPlus-exported PDF, else null. */
export function readEmbeddedLog(data: ArrayBuffer): Promise<any | null> {
  return readEmbedded(data);
}

/** Render a game to a PaifuPlus paifu PDF (bytes), with its tenhou log embedded. */
export function exportPaifuPdf(game: Game, lang: PaifuLang): Promise<Uint8Array> {
  return gameToPaifuPdf(game, lang);
}
