/**
 * Browser-side PDF import: load a File/ArrayBuffer with pdfjs, extract each
 * page, and parse into Kyoku[]. Uses the pure-JS md5 so tile hashes match the
 * table built under Node.
 */
import { getDocument, GlobalWorkerOptions, OPS } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { extractPage } from './extract.js';
import { parseKyoku } from './parse.js';
import { md5hex } from './md5.js';
import type { Kyoku } from '../core/model.js';

GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * Canonical RGB hash of a pdfjs image object. In the browser images arrive as
 * an ImageBitmap; draw it to a canvas and read pixels, dropping alpha, to get
 * the same RGB bytes Node exposes directly in o.data.
 */
function hashImage(o: any): string {
  let rgb: Uint8Array | null = null;
  if (o?.bitmap) {
    const cv = new OffscreenCanvas(o.width, o.height);
    const ctx = cv.getContext('2d', { willReadFrequently: true } as any)!;
    (ctx as any).imageSmoothingEnabled = false;
    ctx.drawImage(o.bitmap, 0, 0);
    const id = ctx.getImageData(0, 0, o.width, o.height).data;
    rgb = new Uint8Array(o.width * o.height * 3);
    for (let i = 0, j = 0; i < id.length; i += 4) { rgb[j++] = id[i]; rgb[j++] = id[i + 1]; rgb[j++] = id[i + 2]; }
  } else if (o?.data) {
    const d = o.data; rgb = d instanceof Uint8Array ? d : new Uint8Array(d.buffer ?? d);
  }
  return rgb ? md5hex(rgb).slice(0, 10) : '';
}

export interface ImportResult {
  kyokus: Kyoku[];
  errors: { page: number; message: string }[];
}

export async function importPdf(data: ArrayBuffer): Promise<ImportResult> {
  const doc = await getDocument({
    data: new Uint8Array(data),
    cMapUrl: new URL('cmaps/', document.baseURI).href,
    cMapPacked: true,
  }).promise;

  const kyokus: Kyoku[] = [];
  const errors: { page: number; message: string }[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const raw = await extractPage(page as any, OPS as any, hashImage);
    try {
      kyokus.push(parseKyoku(raw));
    } catch (e) {
      errors.push({ page: p, message: (e as Error).message });
    }
  }
  kyokus.sort((a, b) => a.round - b.round || a.honba - b.honba);
  return { kyokus, errors };
}
