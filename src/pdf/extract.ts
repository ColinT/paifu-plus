/**
 * Low-level PDF extraction: turn a pdfjs page into a RawPage of positioned text
 * and positioned tile images (with a content hash). This layer is isomorphic —
 * pdfjs runs in Node and the browser — but the byte-hashing function is injected
 * so each environment can supply its own (Node: crypto; browser: a JS md5).
 */

export interface RawText {
  x: number;
  y: number;
  str: string;
}

export interface RawTile {
  x: number;
  y: number;
  w: number;
  h: number;
  hash: string;
  /** width > height in the decoded bitmap → a rotated called-meld tile. */
  landscape: boolean;
}

export interface RawPage {
  width: number;
  height: number;
  texts: RawText[];
  tiles: RawTile[];
}

type Matrix = [number, number, number, number, number, number];
const mul = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

export type Hasher = (bytes: Uint8Array) => string;

// Minimal shapes we rely on from pdfjs (avoids a hard type dependency here).
interface PdfOps { fnArray: number[]; argsArray: any[][]; }
interface PdfPage {
  getViewport(o: { scale: number }): { width: number; height: number };
  getTextContent(): Promise<{ items: any[] }>;
  getOperatorList(): Promise<PdfOps>;
  objs: { get(name: string, cb?: (o: any) => void): any };
}

export interface OpsCodes {
  save: number; restore: number; transform: number;
  paintImageXObject: number; paintImageMaskXObject: number; paintJpegXObject: number;
}

function rawBytes(o: any): Uint8Array {
  const d = o.data;
  if (d instanceof Uint8Array) return d;
  if (d && d.buffer) return new Uint8Array(d.buffer);
  return new Uint8Array(d);
}

export async function extractPage(page: PdfPage, OPS: OpsCodes, hash: Hasher): Promise<RawPage> {
  const vp = page.getViewport({ scale: 1 });

  const tc = await page.getTextContent();
  const texts: RawText[] = tc.items
    .filter((it) => typeof it.str === 'string' && it.str.length > 0)
    .map((it) => ({ x: Math.round(it.transform[4]), y: Math.round(it.transform[5]), str: it.str }));

  const ops = await page.getOperatorList();
  const stack: Matrix[] = [];
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  const paints: { name: string; x: number; y: number; w: number; h: number }[] = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    if (fn === OPS.save) stack.push(ctm.slice() as Matrix);
    else if (fn === OPS.restore) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) ctm = mul(ctm, ops.argsArray[i] as Matrix);
    else if (fn === OPS.paintImageXObject || fn === OPS.paintImageMaskXObject || fn === OPS.paintJpegXObject) {
      paints.push({
        name: ops.argsArray[i][0],
        x: Math.round(ctm[4]),
        y: Math.round(ctm[5]),
        w: Math.hypot(ctm[0], ctm[1]),
        h: Math.hypot(ctm[2], ctm[3]),
      });
    }
  }

  const hashByName = new Map<string, string>();
  const landByName = new Map<string, boolean>();
  const get = (name: string): Promise<any> =>
    new Promise((res) => { try { const o = page.objs.get(name, res); if (o) res(o); } catch { res(null); } });
  for (const p of paints) {
    if (!hashByName.has(p.name)) {
      const o = await get(p.name);
      hashByName.set(p.name, o ? hash(rawBytes(o)) : 'MISSING');
      landByName.set(p.name, o ? o.width > o.height : false);
    }
  }

  const tiles: RawTile[] = paints.map((p) => ({
    x: p.x, y: p.y, w: Math.round(p.w), h: Math.round(p.h),
    hash: hashByName.get(p.name)!, landscape: landByName.get(p.name)!,
  }));

  return { width: Math.round(vp.width), height: Math.round(vp.height), texts, tiles };
}
